FROM node:22

WORKDIR /app

COPY package*.json ./

ENV TZ=America/Sao_Paulo
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN npm install
# Install the necessary dependencies for your application
# Install xvfb, xauth, NSS, and the necessary graphics libraries including libgbm
RUN apt-get update && apt-get install -yq \
    libgconf-2-4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libasound2 \
    fonts-liberation \
    fonts-unifont \
    xvfb \
    xauth \
    libnss3 \
    libgbm1 \
    --no-install-recommends

COPY . .

EXPOSE 3000

# Run xvfb in the background and then start your Node.js application
CMD ["sh", "-c", "xvfb-run --auto-servernum --server-args='-screen 0 640x480x24' node index.js"]