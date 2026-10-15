

#  WhatsApp-Zabbix Bot

Um bot de monitoramento que integra o Zabbix com o WhatsApp para o envio automático de alertas de alta severidade. O bot permite configuração flexível via arquivo e envia alertas para grupos específicos por contrato ou para um grupo padrão.

---

##  Características

* **Monitoramento Automático:** Acompanha eventos Zabbix não tratados.
* **Filtragem por Severidade:** Filtra alertas por severidade (Alta e Crítica por padrão).
* **Agrupamento Inteligente:** Agrupa alertas por contrato.
* **Notificações de Resolução:** Envia notificações para eventos de longa duração resolvidos.
* **Configuração Flexível:** Utiliza um arquivo `.cfg` para todas as configurações.
* **Cache de Eventos:** Evita duplicações de alertas.
* **Comandos Manuais:** Permite consultas sob demanda via comandos no WhatsApp.

---

##  Pré-requisitos

Para rodar o bot, você precisará de:

* **Node.js:** Versão 14 ou superior.
* **Conta WhatsApp:** Uma conta para o bot.
* **Servidor Zabbix:** Com a API habilitada.
* **Token de Autenticação do Zabbix:** Para acesso à API.

---

## Instalação

Siga os passos abaixo para configurar e executar o bot:

1.  **Clone o repositório:**
    ```bash
    git clone https://github.com/FranciscoSavastano/whatsapp-zabbix-bot
    cd whatsapp-zabbix-bot
    ```

2.  **Instale as dependências:**
    ```bash
    npm install
    ```

3.  **Configure o arquivo `config.cfg`:** (Veja a seção [Configuração](#-configuração))

4.  **Execute o bot:**
    ```bash
    npm start
    ```

---

## Configuração

Crie um arquivo `config.cfg` na raiz do projeto com as seguintes configurações:

```ini
# Configurações do Sistema de Monitoramento Zabbix

[GENERAL]
TIMEZONE=America/Sao_Paulo
# MIN_SEVERITY é o nível mínimo de severidade para alertas
MIN_SEVERITY=4
# ID DO GRUPO DE FALLBACK
DEFAULT_GROUP_ID=

[ZABBIX]
API_URL=#http://SERVER_IP/zabbix/api_jsonrpc.php
API_TOKEN=

[CONTRACT_GROUPS]
# EXEMPLO
# GROUP1 = WHATSAPP_GROUP_ID

[ALLOWED_HOSTS]
# EXEMPLO
#HOSTS=HOST_NAME1,HOST_NAME2,HOST_NAME3

[BLOCKED_HOSTS]
# EXEMPLO
# GROUP=HOST_NAME

[ALLOWED_HOSTS_CONTRACTS]
#CONTRACTS=
````

### Parâmetros de Configuração

* **`[GENERAL]`**
    * **`TIMEZONE`**: Fuso horário para exibição de datas (padrão: `America/Sao_Paulo`).
    * **`MIN_SEVERITY`**: Severidade mínima para alertas (4=Alta, 5=Crítica).
    * **`DEFAULT_GROUP_ID`**: ID do grupo WhatsApp padrão para alertas sem grupo específico.
* **`[ZABBIX]`**
    * **`API_URL`**: URL da API JSON-RPC do Zabbix.
    * **`API_TOKEN`**: Token de autenticação da API do Zabbix.
* **`[CONTRACT_GROUPS]`**
    * Mapeamento de códigos de contrato para IDs de grupos WhatsApp.
    * **Formato:** `CODIGO_CONTRATO=ID_GRUP_WHATSAPP@g.us`
* **`[ALLOWED_HOSTS]`**
    * Lista de tipos de hosts permitidos (separados por vírgula).
    * Usado para filtrar quais hosts podem ser enviados para grupos específicos.
* **`[BLOCKED_HOSTS]`**
    * Hosts bloqueados por contrato.
    * **Formato:** `CONTRATO=SUBSTRING_BLOQUEADA`
* **`[ALLOWED_HOSTS_CONTRACTS]`**
    * Contratos que devem verificar hosts permitidos.
    * Se um contrato estiver nesta lista, apenas hosts da lista `ALLOWED_HOSTS` serão enviados para o grupo específico.

-----

## Funcionalidades

### Monitoramento Automático

* Verifica eventos não tratados a cada 1 minuto.
* Filtra eventos por severidade (Alta/Crítica).
* Agrupa alertas por contrato.
* Evita duplicação de notificações.
* Sistema de re-verificação (10 minutos) antes do primeiro envio.

### Sistema de Grupos

* **Grupos Específicos:** Alertas enviados para o grupo do contrato correspondente.
* **Grupo Padrão:** Alertas de contratos sem grupo ou hosts não permitidos.
* **Validação:** Verifica se os grupos existem e o bot tem acesso.

### Notificações de Resolução

* Monitora eventos resolvidos.
* Envia notificação apenas para eventos de longa duração (\>10 minutos).
* Calcula e exibe a duração total do problema.

### Comandos Manuais

| Comando         | Descrição                                         |
| :-------------- | :------------------------------------------------ |
| `!zabbix`       | Lista eventos de alta severidade não tratados.    |
| `!zabbix todos` | Lista todos os eventos não tratados (todas as severidades). |
| `!status`       | Exibe estatísticas do sistema.                    |
| `@grupo`        | Obtém o ID do grupo atual.                        |

-----

## Estrutura de Alertas

### Alerta de Problema

```
⚠️ ALERTA DO ZABBIX - 2 eventos para EXEMPLO1 ⚠️

--- Evento 1 ---
Host: EXAMPLO1-SERVER-01
Problema: High CPU utilization
Horario: 15/03/2024 14:30:25
Detalhes: CPU utilization is 95%
Este alerta continua sem tratamento. Duração: 15m 30s

--- Evento 2 ---
Host: EXAMPLO1-TOTEM-02
Problema: Network interface down
Horario: 15/03/2024 14:25:10
Detalhes: Interface eth0 is down
Este alerta continua sem tratamento. Duração: 20m 45s
```

### Alerta de Resolução

```
✅ ALERTAS RESOLVIDOS - 1 eventos para EXEMPLO2 ✅

--- Evento 1 ---
Host: EXAMPLO2-SERVER-01
Problema: High CPU utilization
Severidade: Alta
Detalhes: CPU utilization is 95%
Este alerta foi resolvido após 25m 15s.
```

-----

## Logs e Monitoramento

O bot gera logs detalhados para:

* Eventos processados e ignorados.
* Validação de grupos WhatsApp.
* Erros de comunicação.
* Estatísticas de cache.

-----

## Containerização

O bot inclui configurações para execução em containers, otimizando o `puppeteer` para ambientes `headless`:

```javascript
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
  ]
}
```

-----

## Dependências

As principais dependências utilizadas pelo bot são:

* [`whatsapp-web.js`](https://wwebjs.dev/): Cliente WhatsApp Web.
* [`qrcode-terminal`](https://www.npmjs.com/package/qrcode-terminal): Geração de QR Code para autenticação.
* [`axios`](https://axios-http.com/): Cliente HTTP para a API do Zabbix.
* `fs`: Sistema de arquivos (nativo Node.js).

-----

## Segurança

* Tokens de API devem ser mantidos seguros no arquivo de configuração.
* O arquivo `config.cfg` **não deve ser commitado** no repositório.
* A autenticação do WhatsApp é mantida localmente na pasta `Auth`.

-----

## Troubleshooting

### Bot não conecta ao WhatsApp

1.  Remova a pasta `Auth`.
2.  Reinicie o bot.
3.  Escaneie o novo QR Code.

### Alertas não chegam

1.  Verifique se o token da API Zabbix está correto.
2.  Confirme se os IDs dos grupos WhatsApp estão válidos.
3.  Verifique os logs para erros de rede.

### Grupos não encontrados

1.  Use o comando `@grupo` para obter IDs corretos.
2.  Verifique se o bot foi adicionado aos grupos.
3.  Confirme o formato: `numero@g.us`.

-----

## Contribuição

Sinta-se à vontade para contribuir com este projeto\!

1.  Fork o projeto.
2.  Crie uma branch para sua feature (`git checkout -b feature/minha-feature`).
3.  Commit suas mudanças (`git commit -m 'Adiciona nova feature'`).
4.  Push para a branch (`git push origin feature/minha-feature`).
5.  Abra um Pull Request.

-----

## Licença

Este projeto está sob licença MIT. Veja o arquivo `LICENSE` para detalhes.
