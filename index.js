import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import fs from 'fs';

// Função para ler arquivo de configuração
function readConfigFile(configPath = './config.cfg') {
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = {};
    let currentSection = null;

    configData.split('\n').forEach(line => {
      line = line.trim();

      // Ignorar comentários e linhas vazias
      if (line.startsWith('#') || line === '') return;

      // Verificar se é uma seção
      if (line.startsWith('[') && line.endsWith(']')) {
        currentSection = line.slice(1, -1);
        config[currentSection] = {};
        return;
      }

      // Processar pares chave=valor
      if (currentSection && line.includes('=')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();

        if (currentSection === 'ALLOWED_HOSTS' && key === 'HOSTS') {
          // Tratar ALLOWED_HOSTS como array
          config[currentSection][key] = value ? value.split(',').map(item => item.trim()) : [];
        } else if (currentSection === 'ALLOWED_HOSTS_CONTRACTS' && key === 'CONTRACTS') {
          // Tratar ALLOWED_HOSTS_CONTRACTS como array
          config[currentSection][key] = value ? value.split(',').map(item => item.trim()) : [];
        } else if (currentSection === 'CONTRACT_GROUPS') {
          // Tratar CONTRACT_GROUPS como objeto
          config[currentSection][key] = value;
        } else if (currentSection === 'BLOCKED_HOSTS') {
          // Tratar BLOCKED_HOSTS como objeto
          config[currentSection][key] = value;
        } else {
          config[currentSection][key] = value;
        }
      }
    });

    return config;
  } catch (error) {
    console.error('Erro ao ler arquivo de configuração:', error);
    process.exit(1);
  }
}

// Carregar configurações
const config = readConfigFile();

// Aplicar configurações do sistema
process.env.TZ = config.GENERAL.TIMEZONE;
console.log(`Data e hora do sistema com TZ forçado: ${new Date().toString()}`);
console.log(`Timezone offset: ${new Date().getTimezoneOffset() / -60} horas`);

// Configuração da API Zabbix
const ZABBIX_API = config.ZABBIX.API_URL;
const API_TOKEN = config.ZABBIX.API_TOKEN;

// Configuração de severidade
const MIN_SEVERITY = parseInt(config.GENERAL.MIN_SEVERITY);

// Mapeamento de contratos para IDs de grupos do WhatsApp
const CONTRACT_GROUPS = config.CONTRACT_GROUPS;

// Hosts permitidos
const ALLOWED_HOSTS = config.ALLOWED_HOSTS.HOSTS;

// Hosts bloqueados
const BLOCKED_HOSTS = config.BLOCKED_HOSTS;

// Contratos com hosts permitidos
const ALLOWED_HOSTS_CONTRACTS = config.ALLOWED_HOSTS_CONTRACTS.CONTRACTS;

// Grupo padrão
const grupoPadrao = config.GENERAL.DEFAULT_GROUP_ID;

let isAllowed = true;
let isResolutionAllowed = true;


// Cache de eventos já notificados para evitar duplicações
const notifiedEvents = new Map();
// Cache de eventos que aguardam confirmação (para re-verificação após 10 min)
const pendingEvents = new Map(); // Map<eventId, timestamp>

// Função para verificar se os IDs dos grupos são válidos e existem no WhatsApp
async function isValidAndExistingGroupIds(client) {
  const groupIds = Object.values(CONTRACT_GROUPS);
  for (const groupId of groupIds) {
    if (!/^\d+@g\.us$/.test(groupId)) {
      console.error(`ID de grupo inválido: ${groupId}`);
      return false;
    }
    if(!/^\d+@g\.us$/.test(grupoPadrao)) {
      console.error(`ID de grupo padrão inválido: ${grupoPadrao}`);
    }
    try {
      await client.getChatById(groupId);
      // Se não lançar erro, o grupo existe e o bot tem acesso
    } catch (err) {
      try {
        await client.getChatById(grupoPadrao);
      }catch (error) {
        console.error(`Grupo padrão não encontrado: ${grupoPadrao}`);
        return false;
      }
      console.error(`Grupo não encontrado ou sem acesso: ${groupId}`);
      return false;
    }
  }
  return true;
}
// Função para extrair o código do contrato do nome do host
function extractContract(hostname) {
  // Assume que o código do contrato é o primeiro segmento antes do hífen
  const match = hostname.match(/^([^-]+)-/);
  return match ? match[1] : 'DESCONHECIDO';
}
// Function to check if a host is blocked for a specific contract
function isHostBlocked(hostName, contract) {
  // Check if the contract exists in BLOCKED_HOSTS
  if (BLOCKED_HOSTS[contract]) {
    const blockedHost = BLOCKED_HOSTS[contract];
    // Check if the blocked host string is present in the host name
    if (hostName.includes(blockedHost)) {
      console.log(`Host ${hostName} está bloqueado para o contrato ${contract}`);
      return true;
    }
  }
  return false;
}
// Função para buscar eventos não tratados do Zabbix com severidade alta ou superior
async function fetchUnacknowledgedEvents() {
  const options = {
    method: 'POST',
    url: ZABBIX_API,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      'content-type': 'application/json'
    },
    data: {
      jsonrpc: '2.0',
      method: 'event.get',
      params: {
        output: 'extend',
        time_from: Math.floor(Date.now() / 1000) - (3600 * 2), // Últimas 2 horas
        sortfield: ['clock', 'eventid'],
        sortorder: 'DESC',
        selectHosts: ['host', 'name'],
        selectRelatedObject: ['description', 'expression'],
        selectHostGroups: ['groupid', 'name'],
        // Filtrar por eventos não reconhecidos (não tratados)
        acknowledged: false,
        // Incluir apenas problemas (não recuperações)
        value: 1,
        // Filtrar por severidade - apenas Alta (4) ou Crítica (5)
        severities: [4, 5]
      },
      id: 2
    }
  };

  try {
    const { data } = await axios.request(options);
    console.log(`Recuperados ${data.result.length} eventos não tratados com severidade alta ou crítica`);
    return data.result;
  } catch (error) {
    console.error("Erro ao buscar dados do Zabbix:", error);
    return [];
  }
}

// Na função formatEventMessage, modifique a última linha para incluir a duração
function formatEventMessage(event){
  let message = `*⚠️ ALERTA DO ZABBIX ⚠️*\n\n`;
  message += `*Host:* ${event.hosts[0].name}\n`;
  message += `*Problema:* ${event.relatedObject.description}\n`;
  message += `*Horario:* ${new Date(parseInt(event.clock) * 1000).toLocaleString('pt-BR')}\n`;
  
  // Mapear número de severidade para texto
  const severityMap = {
    '4': 'Alta',
    '5': 'Crítica'
  };
  message += `*Detalhes:* ${event.name}`;
  if (event.opdata) message += ` - ${event.opdata}`;
  
  // Calcular duração do evento até agora
  const eventTimestamp = parseInt(event.clock) * 1000; // Converter para milissegundos
  const currentTimestamp = Date.now();
  const durationMs = currentTimestamp - eventTimestamp;
  
  // Converter para formato legível
  const seconds = Math.floor((durationMs / 1000) % 60);
  const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
  const hours = Math.floor((durationMs / (1000 * 60 * 60)) % 24);
  const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
  
  let durationText = "";
  if (days > 0) durationText += `${days}d `;
  if (hours > 0 || days > 0) durationText += `${hours}h `;
  if (minutes > 0 || hours > 0 || days > 0) durationText += `${minutes}m `;
  durationText += `${seconds}s`;
  
  message += `\n\n_Este alerta continua sem tratamento. Duração: ${durationText}_`;
  
  return message;
}

// Função principal que verifica e notifica eventos
async function checkAndNotifyEvents(client) {
  console.log("Verificando eventos não tratados de alta severidade...");
  const events = await fetchUnacknowledgedEvents();
  
  // Map para agrupar eventos por contrato
  const eventsByContract = new Map();
  
  // Processar eventos atuais
  for (const event of events) {
    // Verificar severidade (redundante, já que a API já filtra, mas por segurança)
    if (parseInt(event.severity) < MIN_SEVERITY) {
      continue;
    }

    const eventId = event.eventid;
    const hostName = event.hosts[0].name;
    const contract = extractContract(hostName);
    const groupId = CONTRACT_GROUPS[contract];
    
    // Se não temos um grupo para este contrato, registrar e pular
    if (!groupId) {
      console.log(`Contrato desconhecido para host: ${hostName} (Contrato extraído: ${contract})`);
    }

    // Verificar se este evento já foi notificado
    if (notifiedEvents.has(eventId)) {
      continue;
    }

    const Host = event.hosts[0].name;

    if (isHostBlocked(Host, contract)) {
      console.log(`Evento ignorado: Host ${Host} está bloqueado para o contrato ${contract}`);
      continue; // Skip this event
    }

    // NOVA VERIFICAÇÃO: Ignorar eventos que já têm um r_eventid não nulo,
    // pois isso significa que o evento já foi resolvido
    if (event.r_eventid && event.r_eventid !== '0') {
      console.log(`Evento ${eventId}, nome ${event.hosts[0].name} já está resolvido (r_eventid: ${event.r_eventid}), ignorando`);
      
      // Podemos opcionalmente registrar este evento diretamente como resolvido
      // para estatísticas ou processamento posterior
      
      continue; // Pular este evento
    }
    // Verificar se o host é permitido para o contrato

    if (ALLOWED_HOSTS_CONTRACTS && ALLOWED_HOSTS_CONTRACTS.includes(contract)) {
      const allowedHost = event.hosts[0].name
      const treatedAllowedHost = allowedHost.replace(/\s+/g, '-').toUpperCase();
      const hostParts = treatedAllowedHost.split('-');
      isAllowed = hostParts.some(part => ALLOWED_HOSTS.includes(part));
      if(!isAllowed) {
        console.log(`Não permitido host ${event.hosts[0].name} para o contrato ${contract}, serão enviados para grupo padrão`)
      }else {
        console.log(`${event.hosts[0].name} é permitido para o contrato ${contract}`);
      }
    }
    // Verificar se este evento está aguardando re-verificação
    if (pendingEvents.has(eventId)) {
      const pendingTime = pendingEvents.get(eventId);
      const tenMinutesAgo = Date.now() - (9 * 60 * 1000); // 9 minutos em ms
      
      // Se já se passaram 10 minutos, agrupar para notificação
      if (pendingTime <= tenMinutesAgo) {
        console.log(`Re-notificando evento ${eventId} , nome ${event.hosts[0].name} de severidade ${event.severity} para o grupo ${contract}`);
        
        // Adicionar evento ao grupo do contrato correspondente
        if (!eventsByContract.has(contract)) {
          eventsByContract.set(contract, []);
        }
        eventsByContract.get(contract).push(event);
        
        // Marcar como notificado e remover dos pendentes
        notifiedEvents.set(eventId, {
          timestamp: Date.now(),
          hostName: event.hosts[0].name,
          description: event.relatedObject.description,
          contract: contract,
          severity: event.severity,
          name: event.name,
          opdata: event.opdata || ''
        });
        pendingEvents.delete(eventId);
      }
    } else {
      // Novo evento, marcar como pendente para re-verificação
      pendingEvents.set(eventId, Date.now());
      console.log(`Evento ${eventId}, nome ${event.hosts[0].name} de severidade ${event.severity} marcado para re-verificação em 10 minutos`);
    }
  }
  
  // Map para agrupar eventos sem grupo específico por contrato
  const defaultGroupEventsByContract = new Map();
  
  // Enviar mensagens agrupadas por contrato
  for (const [contract, contractEvents] of eventsByContract.entries()) {
    try {
      const groupId = CONTRACT_GROUPS[contract];
      
      if (!groupId | !isAllowed) { 
        // Se não temos um grupo para este contrato ou o host não é permitido, enviar para o grupo padrão
        console.log(`Grupo não encontrado ou host não permitido para o contrato ${contract}, enviando para o grupo padrão`);
        // Agrupar por contrato para o grupo padrão
        if (!defaultGroupEventsByContract.has(contract)) {
          defaultGroupEventsByContract.set(contract, []);
        }
        defaultGroupEventsByContract.get(contract).push(...contractEvents);
        console.log(`Eventos do contrato ${contract} serão enviados ao grupo padrão`);
      } else {
        // Enviar para o grupo específico do contrato
        const chat = await client.getChatById(groupId);
        console.log(`Enviando notificação agrupada para ${contract} sobre ${contractEvents.length} eventos`);
        // Formatar mensagem agrupada
        const message = formatGroupedEventMessages(contractEvents, contract);
        await chat.sendMessage(message);
      }
    } catch (error) {
      console.error(`Erro ao enviar mensagem agrupada para contrato ${contract}:`, error);
    }
  }
  
  // Enviar eventos agrupados para o grupo padrão, separados por contrato
  if (defaultGroupEventsByContract.size > 0) {
    const defaultGroupChat = await client.getChatById(grupoPadrao); // Grupo padrão
    
    for (const [contract, events] of defaultGroupEventsByContract.entries()) {
      try {
        const message = formatGroupedEventMessages(events, contract);
        await defaultGroupChat.sendMessage(message);
        console.log(`Enviando notificação agrupada para grupo padrão sobre ${events.length} eventos do contrato ${contract}`);
      } catch (error) {
        console.error(`Erro ao enviar mensagem agrupada para grupo padrão (contrato ${contract}):`, error);
      }
    }
  }
  
  // Limpar eventos pendentes que não estão mais ativos
  const activeEventIds = new Set(events.map(e => e.eventid));
  for (const [pendingId] of pendingEvents) {
    if (!activeEventIds.has(pendingId)) {
      console.log(`Evento ${pendingId} não está mais ativo, removendo da lista de pendentes`);
      pendingEvents.delete(pendingId);
    }
  }
}

// Função para formatar mensagens agrupadas
function formatGroupedEventMessages(events, contract) {
  let message = `*⚠️ ALERTA DO ZABBIX - ${events.length} eventos para ${contract} ⚠️*\n\n`;
  
  events.forEach((event, index) => {
    if(index > 0) message += "\n\n"; // Adiciona espaçamento entre eventos
    message += `*--- Evento ${index + 1} ---*\n`;
    message += `*Host:* ${event.hosts[0].name}\n`;
    message += `*Problema:* ${event.relatedObject.description}\n`;
    message += `*Horario:* ${new Date(parseInt(event.clock) * 1000).toLocaleString('pt-BR')}\n`;
    
    // Mapear número de severidade para texto
    const severityMap = {
      '4': 'Alta',
      '5': 'Crítica'
    };
    message += `*Detalhes:* ${event.name}\n`;
    if (event.opdata) message += ` - ${event.opdata}`;
    
    // Calcular duração do evento até agora
    const eventTimestamp = parseInt(event.clock) * 1000; // Converter para milissegundos
    const currentTimestamp = Date.now();
    const durationMs = currentTimestamp - eventTimestamp;
    
    // Converter para formato legível
    const seconds = Math.floor((durationMs / 1000) % 60);
    const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
    const hours = Math.floor((durationMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
    
    let durationText = "";
    if (days > 0) durationText += `${days}d `;
    if (hours > 0 || days > 0) durationText += `${hours}h `;
    if (minutes > 0 || hours > 0 || days > 0) durationText += `${minutes}m `;
    durationText += `${seconds}s`;
    
    message += `\n_Este alerta continua sem tratamento. Duração: ${durationText}_`;
  });
  return message;
}

async function checkResolvedEvents(client) {
  console.log("Verificando eventos resolvidos...");
  
  // Se não há eventos para notificar, retorne
  if (notifiedEvents.size === 0) {
    console.log("Nenhum evento notificado para verificar");
    return;
  }
  
  // Obter todos os eventos ativos
  const activeEvents = await fetchUnacknowledgedEvents();
  
  // Map para armazenar IDs de eventos ativos
  const activeEventIds = new Set(activeEvents.map(e => e.eventid));
  
  // Map para armazenar eventos com recovery IDs
  const recoveryEvents = new Map();
  
  // Extrair os recovery event IDs dos eventos ativos
  activeEvents.forEach(event => {
    if (event.r_eventid && event.r_eventid !== '0') {
      recoveryEvents.set(event.eventid, event.r_eventid);
    }
  });
  
  // Map para agrupar eventos resolvidos por contrato
  const resolvedEventsByContract = new Map();
  for (const [eventId, eventDetails] of notifiedEvents.entries()) {
    // Verificar se o host é permitido para o contrato
    if (ALLOWED_HOSTS_CONTRACTS.includes(eventDetails.contract)) {
      const allowedHost = eventDetails.hostName;
      const treatedAllowedHost = allowedHost.replace(/\s+/g, '-').toUpperCase();
      const hostParts = treatedAllowedHost.split('-');
      isResolutionAllowed = hostParts.some(part => ALLOWED_HOSTS.includes(part));
    }
    if(isResolutionAllowed) {
      console.log("Acima é permitido em grupo")
    }else {
      console.log("Acima não é permitido em grupo")
    }
    // Verificar se o evento não está mais ativo ou tem um recovery event ID
    const isResolved = recoveryEvents.has(eventId) //!activeEventIds.has(eventId) || recoveryEvents.has(eventId); //Desabilitado pois estava causando problemas
    if (isResolved) {
      // Verificar se o evento durou mais de 10 minutos antes de ser resolvido
      const now = Date.now();
      const eventDuration = now - eventDetails.timestamp;
      const tenMinutesInMs = 9 * 60 * 1000; // 3 minutos para teste, ajuste para 10min em produção
      
      // Apenas notifique as resoluções de eventos que duraram mais de o tempo mínimo
      if (eventDuration > tenMinutesInMs) {
        const resolvedEvent = {
          eventId,
          ...eventDetails,
          resolutionTime: now,
          duration: eventDuration,
          // Se disponível, inclua o ID do evento de recuperação
          recoveryEventId: recoveryEvents.get(eventId) || 'N/A'
        };
        
        // Agrupar por contrato
        if (!resolvedEventsByContract.has(eventDetails.contract)) {
          resolvedEventsByContract.set(eventDetails.contract, []);
        }
        resolvedEventsByContract.get(eventDetails.contract).push(resolvedEvent);
        console.log(`Evento resolvido: ${eventId}, ${eventDetails.hostName} , Recovery ID: ${recoveryEvents.get(eventId) || 'N/A'}`);
      }
      
      // Em qualquer caso, remova o evento da lista de notificados
      console.log(`Removendo evento ${eventId} da lista de notificados`);
      notifiedEvents.delete(eventId);
    }
  }

  // Map para agrupar eventos resolvidos sem grupo específico por contrato
  const defaultResolvedEventsByContract = new Map();
 
  // Enviar mensagens agrupadas de eventos resolvidos por contrato
  for (const [contract, events] of resolvedEventsByContract.entries()) {
    try {
      const groupId = CONTRACT_GROUPS[contract];
  
      for (const event of events) {
        const allowedHost = event.hostName;
        const treatedAllowedHost = allowedHost.replace(/\s+/g, '-').toUpperCase();
        const hostParts = treatedAllowedHost.split('-');
  
        // Check if the host is allowed
        const isAllowed = hostParts.some(part => ALLOWED_HOSTS.includes(part));
  
        if (!isAllowed || !groupId) {
          console.log(
            `Host ${allowedHost} não permitido ou grupo não definido para o contrato ${contract}. Enviando para o grupo padrão.`
          );
  
          // Add the event to the default group
          if (!defaultResolvedEventsByContract.has(contract)) {
            defaultResolvedEventsByContract.set(contract, []);
          }
          defaultResolvedEventsByContract.get(contract).push(event);
        } else {
          console.log(
            `Host ${allowedHost} permitido e grupo definido para o contrato ${contract}.`
          );
  
          // Send the event to the specific group
          const chat = await client.getChatById(groupId);
          const message = formatGroupedResolvedEventMessages([event], contract);
          await chat.sendMessage(message);
        }
      }
    } catch (error) {
      console.error(`Erro ao processar eventos para o contrato ${contract}:`, error);
    }
  }
  
  // Send events to the default group
  if (defaultResolvedEventsByContract.size > 0) {
    const defaultGroupChat = await client.getChatById(grupoPadrao); // Grupo do Padrão
    for (const [contract, events] of defaultResolvedEventsByContract.entries()) {
      try {
        const message = formatGroupedResolvedEventMessages(events, contract);
        await defaultGroupChat.sendMessage(message);
        console.log(
          `Enviando notificação agrupada de resolução para grupo padrão sobre ${events.length} eventos do contrato ${contract}`
        );
      } catch (error) {
        console.error(
          `Erro ao enviar mensagem agrupada de resolução para grupo padrão (contrato ${contract}):`,
          error
        );
      }
    }
  }
}

// Função para formatar mensagens agrupadas de eventos resolvidos
function formatGroupedResolvedEventMessages(events, contract) {
  let message = `*✅ ALERTAS RESOLVIDOS - ${events.length} eventos para ${contract} ✅*\n\n`;
  
  events.forEach((event, index) => {
    if(index > 0) message += "\n\n"; // Adiciona espaçamento entre eventos
    message += `*--- Evento ${index + 1} ---*\n`;
    message += `*Host:* ${event.hostName}\n`;
    message += `*Problema:* ${event.description}\n`;
    
    // Mapear número de severidade para texto
    const severityMap = {
      '4': 'Alta',
      '5': 'Crítica'
    };
    message += `*Severidade:* ${severityMap[event.severity] || event.severity}\n`;
    message += `*Detalhes:* ${event.name}`;
    if (event.opdata) message += ` - ${event.opdata}`;
    
    // Calcular duração do evento até agora
    const durationMs = event.duration;

    // Converter para formato legível
    const seconds = Math.floor((durationMs / 1000) % 60);
    const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
    const hours = Math.floor((durationMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
    
    let durationText = "";
    if (days > 0) durationText += `${days}d `;
    if (hours > 0 || days > 0) durationText += `${hours}h `;
    if (minutes > 0 || hours > 0 || days > 0) durationText += `${minutes}m `;
    durationText += `${seconds}s`;
    
    message += `\n_Este alerta foi resolvido após ${durationText}._\n\n`;
  });
  
  return message;
}

// Função para formatar a mensagem de resolução
function formatResolvedEventMessage(event) {
  let message = `*✅ ALERTA RESOLVIDO ✅*\n\n`;
  message += `*Host:* ${event.hostName}\n`;
  message += `*Problema:* ${event.description}\n`;
  
  // Mapear número de severidade para texto
  const severityMap = {
    '4': 'Alta',
    '5': 'Crítica'
  };
  message += `*Severidade:* ${severityMap[event.severity] || event.severity}\n`;
  message += `*Detalhes:* ${event.name}`;
  if (event.opdata) message += ` - ${event.opdata}`;
  
  // Calcular duração do evento
  const durationMs = event.duration;
  
  // Converter para formato legível
  const seconds = Math.floor((durationMs / 1000) % 60);
  const minutes = Math.floor((durationMs / (1000 * 60)) % 60);
  const hours = Math.floor((durationMs / (1000 * 60 * 60)) % 24);
  const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
  
  let durationText = "";
  if (days > 0) durationText += `${days}d `;
  if (hours > 0 || days > 0) durationText += `${hours}h `;
  if (minutes > 0 || hours > 0 || days > 0) durationText += `${minutes}m `;
  durationText += `${seconds}s`;
  
  message += `\n\n_Este alerta foi resolvido após ${durationText}._`;
  
  return message;
}

// Função para limpar cache de eventos antigos (manter por 48h)
function cleanupOldEvents() {
  const fortyEightHoursAgo = Date.now() - (48 * 60 * 60 * 1000);
  
  const eventIdsToRemove = [];
  for (const eventId of notifiedEvents) {
    // Aqui você precisaria de um timestamp para cada evento
    // Como simplificação, você pode implementar uma estrutura que armazene {eventId: timestamp}
    // E então remover com base no timestamp
    
    // Por enquanto, esta parte está simplificada
    // eventIdsToRemove.push(eventId);
  }
  
  for (const id of eventIdsToRemove) {
    notifiedEvents.delete(id);
  }
  
  console.log(`Limpeza de cache: ${eventIdsToRemove.length} eventos antigos removidos`);
}

// Função principal
(async () => {
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: 'Auth'
    }),
    //Opções para funcionamento em containers.
    puppeteer: {
      headless: true,
      args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
      ]},
  });

  client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('Cliente WhatsApp está pronto!');
  // Verifique a existencia e validade dos IDs dos grupos
    const valid = await isValidAndExistingGroupIds(client);
    if (!valid) {
      //Feche o processo se algum ID de grupo for inválido
      console.error("Algum ID de grupo está inválido. Verifique os IDs dos grupos.");
      process.exit(1);
    } else {
      console.log("Todos os IDs de grupo estão válidos.");
    }
    // Verificação inicial após inicialização
    setTimeout(() => checkAndNotifyEvents(client), 5000);
    
    // Configurar verificações periódicas
    // Tenha cuidado com a frequência para não sobrecarregar o Zabbix
    setInterval(() => checkAndNotifyEvents(client), 1 * 60 * 1000); // A cada 1 minuto
    
    // Adicionar verificação de eventos resolvidos
    setInterval(() => checkResolvedEvents(client), 1 * 60 * 1000); // A cada 1 minuto
    
    // Configurar limpeza periódica do cache
    setInterval(cleanupOldEvents, 6 * 60 * 60 * 1000); // A cada 6 horas
  });
  // Manter o comando manual !zabbix para consultas sob demanda
  client.on('message_create', async message => {
    if (message.body === '!zabbix') {
      try {
        const events = await fetchUnacknowledgedEvents();
        const contact = await message.getContact(); // Obter o contato do remetente
        const privateChat = await contact.getChat(); // Obter o chat privado do remetente
    
        if (events.length > 0) {
          let messageBody = "*Eventos Zabbix de Alta Severidade não tratados:*\n\n";
          events.forEach(event => {
            messageBody += `*Host:* ${event.hosts[0].name}\n`;
            messageBody += `*Descrição:* ${event.relatedObject.description}\n`;
            messageBody += `*Horario:* ${new Date(parseInt(event.clock) * 1000).toLocaleString('pt-BR')}\n`;
            const severityMap = {
              '4': 'Alta',
              '5': 'Crítica'
            };
            messageBody += `*Severidade:* ${severityMap[event.severity] || event.severity}\n`;
    
            messageBody += `*Detalhes:* ${event.name}`;
            if (event.opdata) messageBody += ` - ${event.opdata}`;
            messageBody += "\n---\n";
          });
    
          
          // Enviar a mensagem no chat privado do remetente
          try{
            await privateChat.sendMessage(messageBody);
          }catch{
            await message.reply(messageBody);
          }
        } else {
          // Enviar mensagem informando que não há eventos no chat privado
          await privateChat.sendMessage("Não há eventos de alta severidade não tratados no momento.");
        }
      } catch (error) {
        console.error("Erro ao processar o comando !zabbix:", error);
        await message.reply("Erro ao processar o comando. Verifique o console para detalhes.");
      }
    }
    // Comando para obter o ID do grupo atual
if (message.body === '@grupo') {
  try {
    // Obter o chat do qual a mensagem foi enviada
    const chat = await message.getChat();

    let responseMessage = "";

    if (chat.isGroup) {
      // Se for um grupo, retorna o ID do grupo
      responseMessage = `*ID do grupo atual:* ${chat.id._serialized}`;
    } else {
      // Se for um chat individual
      responseMessage = `Este não é um grupo. Este comando funciona apenas em grupos.`;
    }

    // Enviar a mensagem para o grupo específico - Evitar caso onde resposta seja enviada para o remetente, causando crash
    if(grupoPadrao) {
      const targetGroupId = grupoPadrao; // ID do grupo padrão
      const targetGroupChat = await client.getChatById(targetGroupId);
      await targetGroupChat.sendMessage(responseMessage);
      console.log(`Mensagem enviada para o grupo ${targetGroupId}: ${responseMessage}`);
    }else {
      console.log(responseMessage );
    }

  } catch (error) {
    console.error("Erro ao processar o comando:", error);
    try {
      await message.reply("Erro ao processar o comando. Verifique o console para detalhes.");
    }catch  (replyError) {
        console.error("Erro ao enviar mensagem de erro:", replyError);
    }
  }
}
    // Comando para listar todos os eventos (incluindo severidades menores)
    if (message.body === '!zabbix todos') {
      // Temporariamente modifica a configuração para buscar todos os eventos
      const options = {
        method: 'POST',
        url: ZABBIX_API,
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          'content-type': 'application/json'
        },
        data: {
          jsonrpc: '2.0',
          method: 'event.get',
          params: {
            output: 'extend',
            time_from: Math.floor(Date.now() / 1000) - (3600 * 24), // Últimas 24 horas
            sortfield: ['clock', 'eventid'],
            sortorder: 'DESC',
            selectHosts: ['host', 'name'],
            selectRelatedObject: ['description', 'expression'],
            selectHostGroups: ['groupid', 'name'],
            acknowledged: false,
            value: 1
          },
          id: 2
        }
      };
    
      try {
        const { data } = await axios.request(options);
        const allEvents = data.result;
    
        // Obter o contato do remetente
        const contact = await message.getContact();
        const privateChat = await contact.getChat(); // Obter o chat privado do remetente
    
        if (allEvents.length > 0) {
          let messageBody = "*Todos os Eventos Zabbix não tratados:*\n\n";
    
          // Mapeamento completo de severidades
          const severityMap = {
            '0': 'Não classificada',
            '1': 'Informação',
            '2': 'Atenção',
            '3': 'Média',
            '4': 'Alta',
            '5': 'Crítica'
          };
          
          allEvents.forEach(event => {
            messageBody += `*Host:* ${event.hosts[0].name}\n`;
            messageBody += `*Descrição:* ${event.relatedObject.description}\n`;
            messageBody += `*Horario:* ${new Date(parseInt(event.clock) * 1000).toLocaleString('pt-BR')}\n`;
            messageBody += `*Severidade:* ${severityMap[event.severity] || event.severity}\n`;
            messageBody += `*Detalhes:* ${event.name}`;
            if (event.opdata) messageBody += ` - ${event.opdata}`;
            messageBody += "\n---\n";
          });
    
          // Enviar a mensagem no chat privado do remetente
          await privateChat.sendMessage(messageBody);
        } else {
          // Enviar mensagem informando que não há eventos no chat privado
          await privateChat.sendMessage("Não há eventos não tratados no momento.");
        }
      } catch (error) {
        console.error("Erro ao buscar todos os eventos:", error);
        await message.reply("Erro ao buscar eventos. Verifique o console para mais detalhes.");
      }
    }
// Comando para status do sistema
if (message.body === '!status') {
  try {
    const stats = {
      pendingEvents: pendingEvents.size,
      notifiedEvents: notifiedEvents.size,
      uptime: process.uptime()
    };

    const statsMessage = `*Status do Sistema*\n\n` +
      `Eventos pendentes: ${stats.pendingEvents}\n` +
      `Eventos notificados: ${stats.notifiedEvents}\n` +
      `Monitorando severidades: ${MIN_SEVERITY}+ (Alta/Crítica)\n` +
      `Uptime: ${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`;

    // Obter o contato do remetente
    const contact = await message.getContact();
    const privateChat = await contact.getChat(); // Obter o chat privado do remetente

    // Enviar a mensagem no chat privado do remetente
    try {
    await privateChat.sendMessage(statsMessage);
    }catch {
      message.reply(statsMessage);
    }
    console.log(`Mensagem de status enviada para o chat privado de ${contact.pushname || contact.number}`);
  } catch (error) {
    console.error("Erro ao processar o comando !status:", error);
    await message.reply("Erro ao processar o comando. Verifique o console para detalhes.");
  }
}
  });

  await client.initialize();
})();