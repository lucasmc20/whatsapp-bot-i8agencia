const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configurações
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-muito-forte-aqui-2025';
const ADMIN_PASSWORD = '@Sucesso2025';

// Middlewares
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitar CSP para desenvolvimento
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting mais permissivo para desenvolvimento
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000, // Aumentado para desenvolvimento
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});
app.use('/api/', limiter);

// Cliente WhatsApp
let client;
let qrCodeData = '';
let isClientReady = false;
let clientStatus = 'disconnected';

// Banco de dados simples em memória
const users = {
  lucas: {
    password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    role: 'admin'
  }
};

const conversations = new Map();
const customerData = new Map();

// Logs para debug
console.log('=== CONFIGURAÇÃO INICIAL ===');
console.log('Usuários disponíveis:', Object.keys(users));
console.log('Senha hash para lucas:', users.lucas.password);
console.log('Verificação de senha:', bcrypt.compareSync(ADMIN_PASSWORD, users.lucas.password));
console.log('JWT Secret:', JWT_SECRET.substring(0, 10) + '...');

// Fluxos de conversa
const conversationFlows = {
  WELCOME: {
    step: 1,
    message: (name) => `Olá, ${name}! Que bom que você entrou em contato com a i8Agência Digital 🎉\nSou o Lucas, consultor de marketing — em que posso te ajudar hoje?`,
    nextStep: 'DIAGNOSIS'
  },
  
  DIAGNOSIS: {
    step: 2,
    message: () => `Para eu te orientar melhor, conta pra mim:\n\n1️⃣ Qual o seu maior desafio hoje? (site lento, pouca visibilidade, pouco engajamento...)\n2️⃣ Você já tem alguma ação de marketing rodando? Se sim, qual?`,
    nextStep: 'VALUE_OFFER'
  },
  
  VALUE_OFFER: {
    step: 3,
    message: () => `Legal, obrigado pelas informações!\n\nPelo que você me falou, sugiro começarmos com uma análise gratuita de SEO e performance do seu site. Em até 24h te envio um relatório com os pontos de melhoria — tudo sem compromisso.`,
    nextStep: 'SUCCESS_CASE'
  },
  
  SUCCESS_CASE: {
    step: 4,
    message: () => `Pra você ver um exemplo real: atendemos a Empresa X no segmento de e-commerce e, em 2 meses, dobramos o tráfico orgânico e aumentamos em 30% a geração de leads.\n\nGostaria de saber mais sobre como conseguimos isso?`,
    nextStep: 'SCHEDULE_CALL'
  },
  
  SCHEDULE_CALL: {
    step: 5,
    message: () => `Se fizer sentido pra você, podemos agendar uma call de 15 min na semana que vem para conversarmos com calma sobre estratégia e valores.\n\nQual dia/horário funciona melhor pra você?`,
    nextStep: 'COMPLETED'
  }
};

// Respostas para objeções
const objectionResponses = {
  'não tenho orçamento': 'Entendo totalmente. Podemos criar um plano enxuto e escalável, começando com apenas os itens essenciais — assim você rende mais sem precisar de um investimento alto de início.',
  'quero pensar': 'Claro! Que tal marcarmos uma mini-call de 10 min para tirar todas as suas dúvidas antes de você tomar a decisão? Sem compromisso.',
  'não tenho tempo': 'Perfeito! Nosso processo é pensado para empresários ocupados. Cuidamos de tudo pra você — você só precisa aprovar as estratégias.',
  'já tenho agência': 'Que bom! Como está sendo a experiência? Às vezes uma segunda opinião ou complemento pode fazer toda diferença nos resultados.'
};

// Inicializar cliente WhatsApp
function initializeWhatsApp() {
  console.log('Inicializando cliente WhatsApp...');
  clientStatus = 'initializing';
  
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: "i8agencia-bot",
      dataPath: './whatsapp-session'
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    }
  });

  client.on('qr', (qr) => {
    console.log('QR Code recebido, gerando imagem...');
    clientStatus = 'qr_code';
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error('Erro ao gerar QR Code:', err);
        return;
      }
      qrCodeData = url;
      io.emit('qr', url);
    });
  });

  client.on('ready', () => {
    console.log('✅ Cliente WhatsApp está pronto!');
    isClientReady = true;
    clientStatus = 'ready';
    qrCodeData = '';
    io.emit('ready');
  });

  client.on('authenticated', () => {
    console.log('✅ Cliente autenticado');
    clientStatus = 'authenticated';
    io.emit('authenticated');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Falha na autenticação:', msg);
    clientStatus = 'auth_failure';
    io.emit('auth_failure', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('❌ Cliente desconectado:', reason);
    isClientReady = false;
    clientStatus = 'disconnected';
    io.emit('disconnected', reason);
  });

  client.on('message', handleMessage);

  client.initialize().catch(err => {
    console.error('Erro ao inicializar cliente:', err);
    clientStatus = 'error';
  });
}

// Manipular mensagens recebidas
async function handleMessage(message) {
  try {
    if (message.from === 'status@broadcast') return;
    
    const contact = await message.getContact();
    const customerPhone = message.from;
    const customerName = contact.pushname || contact.name || 'Cliente';
    const messageText = message.body.toLowerCase().trim();

    console.log(`📱 Mensagem recebida de ${customerName} (${customerPhone}): ${message.body}`);

    // Salvar dados do cliente
    if (!customerData.has(customerPhone)) {
      customerData.set(customerPhone, {
        name: customerName,
        phone: customerPhone,
        startTime: new Date(),
        messages: []
      });
    }

    const customer = customerData.get(customerPhone);
    customer.messages.push({
      text: message.body,
      timestamp: new Date(),
      type: 'received'
    });

    // Verificar se é uma objeção conhecida
    const objection = Object.keys(objectionResponses).find(key => 
      messageText.includes(key)
    );

    if (objection) {
      await sendMessage(customerPhone, objectionResponses[objection]);
      customer.messages.push({
        text: objectionResponses[objection],
        timestamp: new Date(),
        type: 'sent'
      });
      io.emit('conversation_update', { phone: customerPhone, customer });
      return;
    }

    // Fluxo principal da conversa
    let conversation = conversations.get(customerPhone);
    
    if (!conversation) {
      // Primeira interação - boas-vindas
      conversation = {
        step: 'WELCOME',
        startTime: new Date(),
        responses: []
      };
      conversations.set(customerPhone, conversation);
      
      const welcomeMsg = conversationFlows.WELCOME.message(customerName);
      await sendMessage(customerPhone, welcomeMsg);
      customer.messages.push({
        text: welcomeMsg,
        timestamp: new Date(),
        type: 'sent'
      });
      
      conversation.step = conversationFlows.WELCOME.nextStep;
    } else {
      // Continuar conversa baseada no step atual
      conversation.responses.push({
        step: conversation.step,
        response: message.body,
        timestamp: new Date()
      });

      const currentFlow = conversationFlows[conversation.step];
      if (currentFlow && currentFlow.nextStep !== 'COMPLETED') {
        const responseMsg = currentFlow.message();
        await sendMessage(customerPhone, responseMsg);
        customer.messages.push({
          text: responseMsg,
          timestamp: new Date(),
          type: 'sent'
        });
        
        conversation.step = currentFlow.nextStep;
      }
    }

    // Emitir atualização para o dashboard
    io.emit('conversation_update', { phone: customerPhone, customer, conversation });
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
  }
}

// Enviar mensagem
async function sendMessage(to, message) {
  if (!isClientReady) {
    console.log('❌ Cliente não está pronto para enviar mensagem');
    return false;
  }

  try {
    await client.sendMessage(to, message);
    console.log(`✅ Mensagem enviada para ${to}: ${message.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    return false;
  }
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log('🔐 Verificando autenticação:', { 
    hasAuthHeader: !!authHeader, 
    hasToken: !!token,
    tokenPreview: token ? token.substring(0, 20) + '...' : 'null'
  });

  if (!token) {
    console.log('❌ Token não fornecido');
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('❌ Token inválido:', err.message);
      return res.status(403).json({ error: 'Token inválido' });
    }
    console.log('✅ Token válido para usuário:', user.username);
    req.user = user;
    next();
  });
}

// Rotas da API
app.post('/api/login', async (req, res) => {
  console.log('🔑 Tentativa de login:', req.body);
  
  const { username, password } = req.body;

  if (!username || !password) {
    console.log('❌ Dados incompletos');
    return res.status(400).json({ error: 'Username e password são obrigatórios' });
  }

  const user = users[username];
  console.log('👤 Usuário encontrado:', !!user);
  
  if (!user) {
    console.log('❌ Usuário não encontrado');
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const passwordMatch = bcrypt.compareSync(password, user.password);
  console.log('🔒 Senha correta:', passwordMatch);
  
  if (!passwordMatch) {
    console.log('❌ Senha incorreta');
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const token = jwt.sign(
    { username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  console.log('✅ Login bem-sucedido para:', username);
  res.json({ 
    token, 
    user: { username, role: user.role },
    message: 'Login realizado com sucesso'
  });
});

app.get('/api/status', authenticateToken, (req, res) => {
  const status = {
    isReady: isClientReady,
    clientStatus: clientStatus,
    totalConversations: conversations.size,
    totalCustomers: customerData.size,
    timestamp: new Date().toISOString()
  };
  
  console.log('📊 Status solicitado:', status);
  res.json(status);
});

app.get('/api/conversations', authenticateToken, (req, res) => {
  const conversationsList = [];
  
  for (const [phone, customer] of customerData.entries()) {
    const conversation = conversations.get(phone);
    conversationsList.push({
      phone,
      customer: {
        ...customer,
        messages: customer.messages.slice(-10) // Últimas 10 mensagens
      },
      conversation,
      lastMessage: customer.messages[customer.messages.length - 1]
    });
  }

  console.log(`📋 ${conversationsList.length} conversas retornadas`);
  res.json(conversationsList);
});

app.get('/api/conversation/:phone', authenticateToken, (req, res) => {
  const phone = req.params.phone;
  const customer = customerData.get(phone);
  const conversation = conversations.get(phone);
  
  if (!customer) {
    return res.status(404).json({ error: 'Conversa não encontrada' });
  }
  
  res.json({
    phone,
    customer,
    conversation
  });
});

app.post('/api/send-message', authenticateToken, async (req, res) => {
  const { to, message } = req.body;

  console.log('📤 Enviando mensagem para:', to);

  if (!to || !message) {
    return res.status(400).json({ error: 'Destinatário e mensagem são obrigatórios' });
  }

  const success = await sendMessage(to, message);
  
  if (success) {
    // Atualizar histórico
    const customer = customerData.get(to);
    if (customer) {
      customer.messages.push({
        text: message,
        timestamp: new Date(),
        type: 'sent'
      });
    }
    
    io.emit('conversation_update', { phone: to, customer });
    res.json({ success: true, message: 'Mensagem enviada com sucesso' });
  } else {
    res.status(500).json({ error: 'Falha ao enviar mensagem. Verifique se o WhatsApp está conectado.' });
  }
});

app.post('/api/send-followup', authenticateToken, async (req, res) => {
  const { phones, message } = req.body;

  if (!phones || !Array.isArray(phones) || !message) {
    return res.status(400).json({ error: 'Lista de telefones e mensagem são obrigatórios' });
  }

  console.log(`📤 Enviando follow-up para ${phones.length} contatos`);

  const results = [];
  
  for (const phone of phones) {
    const success = await sendMessage(phone, message);
    results.push({ phone, success });
    
    if (success) {
      const customer = customerData.get(phone);
      if (customer) {
        customer.messages.push({
          text: message,
          timestamp: new Date(),
          type: 'sent'
        });
      }
    }
    
    // Delay entre mensagens para evitar spam
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`✅ ${successCount}/${phones.length} mensagens enviadas`);

  res.json({ 
    results, 
    summary: {
      total: phones.length,
      success: successCount,
      failed: phones.length - successCount
    }
  });
});

// Rota para reiniciar o cliente WhatsApp
app.post('/api/restart-whatsapp', authenticateToken, async (req, res) => {
  try {
    console.log('🔄 Reiniciando cliente WhatsApp...');
    
    if (client) {
      await client.destroy();
    }
    
    isClientReady = false;
    clientStatus = 'restarting';
    qrCodeData = '';
    
    setTimeout(() => {
      initializeWhatsApp();
    }, 2000);
    
    res.json({ message: 'Cliente WhatsApp reiniciado' });
  } catch (error) {
    console.error('Erro ao reiniciar cliente:', error);
    res.status(500).json({ error: 'Erro ao reiniciar cliente WhatsApp' });
  }
});

// Socket.IO para tempo real
io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado ao dashboard');

  socket.on('request_qr', () => {
    console.log('📱 QR Code solicitado');
    if (qrCodeData) {
      socket.emit('qr', qrCodeData);
    } else if (isClientReady) {
      socket.emit('ready');
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado do dashboard');
  });
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota de teste
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Servidor funcionando!',
    timestamp: new Date().toISOString(),
    status: clientStatus,
    isReady: isClientReady
  });
});

// Middleware de erro global
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Rota 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Inicializar servidor
server.listen(PORT, () => {
  console.log('\n=== SERVIDOR INICIADO ===');
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`🔑 Usuário: lucas`);
  console.log(`🔒 Senha: ${ADMIN_PASSWORD}`);
  console.log('========================\n');
  
  // Inicializar WhatsApp após o servidor estar rodando
  setTimeout(() => {
    initializeWhatsApp();
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Encerrando servidor...');
  
  if (client) {
    try {
      await client.destroy();
      console.log('✅ Cliente WhatsApp encerrado');
    } catch (error) {
      console.error('❌ Erro ao encerrar cliente:', error);
    }
  }
  
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});