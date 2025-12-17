// server.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import cors from 'cors'; 

// Database Imports
import connectDB from './db.js';
import User from './models/User.js'; 
import authRoutes from './routes/auth.js'; 

dotenv.config();
connectDB(); // Connect to MongoDB

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const __dirname = path.resolve();
const JWT_SECRET = process.env.JWT_SECRET;
const SUPPORTED_STOCKS = ['GOOG', 'TSLA', 'AMZN', 'META', 'NVDA'];

// Stock Prices (Simulated)
let STOCKS = {}; 
SUPPORTED_STOCKS.forEach(ticker => {
    STOCKS[ticker] = 100 + Math.random() * 200; 
});

// Market Metrics
let MARKET_INDEX = 1000.0;
let PORTFOLIO_BETA_BASE = 1.2;
let DIVERSIFICATION_SCORE_BASE = 75;

// Data Stores
const activeConnections = new Map(); 

// --- Server Setup ---
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true }); 

// ==========================================
// ✅ CRITICAL CORS FIX (Preserved)
// ==========================================
const allowedOrigins = [
  "https://stock-exch.vercel.app", 
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.options('*', cors());
// ==========================================

app.use(express.json()); 
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.send('Stock Broker API with Transaction History is running.');
});

app.use('/api/auth', authRoutes);


// --- WebSocket Logic ---

const authenticateWS = (token) => {
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded;
    } catch (err) {
        return null; 
    }
};

server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    const authPayload = authenticateWS(token);

    if (!authPayload) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    request.userId = authPayload.id;
    request.userEmail = authPayload.email;

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', async (ws, req) => {
    const userId = req.userId;
    const email = req.userEmail;

    if (activeConnections.has(userId)) {
        activeConnections.get(userId).ws.close(1000, 'New connection established.');
        activeConnections.delete(userId);
    }
    
    let user = await User.findById(userId);

    if (!user) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'User not found.' }));
        ws.close();
        return;
    }
    
    const subscribed = new Set(user.subscriptions || SUPPORTED_STOCKS); 
    activeConnections.set(userId, { ws, email, subscribed });
    
    // ✅ PREPARE TRANSACTION HISTORY
    // Map DB format to the format frontend expects
    const history = user.transactions.map(t => ({
        time: new Date(t.date).toLocaleString(),
        action: t.action,
        ticker: t.ticker,
        quantity: t.quantity,
        price: t.price,
        tradeValue: t.tradeValue,
        status: 'SUCCESS'
    })).reverse(); // Show newest first

    const initialData = {
        type: 'INIT',
        email: user.email,
        cash: user.cash,
        portfolio: formatPortfolioForClient(user.portfolio),
        stocks: STOCKS,
        subscriptions: Array.from(subscribed),
        activeAlerts: user.alerts ? Object.fromEntries(user.alerts) : {},
        riskMetrics: calculateRiskMetrics(user.portfolio),
        transactions: history // <--- SEND HISTORY HERE
    };
    ws.send(JSON.stringify(initialData));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            switch (data.type) {
                case 'BUY':
                case 'SELL':
                    await processTrade(userId, data.ticker, data.quantity, data.type);
                    break;
                case 'SUBSCRIBE':
                    handleSubscription(userId, data.ticker, data.action);
                    break;
                case 'SET_ALERT':
                    await handleAlert(userId, data.ticker, data.threshold);
                    break;
            }
        } catch (e) {
            console.error('WS Error:', e);
        }
    });

    ws.on('close', () => {
        activeConnections.delete(userId);
    });
});


// --- Core DB/Business Logic Functions ---

// ✅ UPDATED: Now returns a 'success' flag
const updatePortfolio = (portfolio, ticker, quantity, type, price) => {
    let tradeMsg = '';
    let holding = portfolio.find(h => h.ticker === ticker);
    let success = false;
    
    if (type === 'BUY') {
        const totalCost = quantity * price;
        if (holding) {
            const newTotalQty = holding.quantity + quantity;
            const newTotalCost = (holding.quantity * holding.avgPrice) + totalCost;
            holding.avgPrice = newTotalCost / newTotalQty;
            holding.quantity = newTotalQty;
        } else {
            portfolio.push({ ticker, quantity, avgPrice: price });
        }
        tradeMsg = `Successfully bought ${quantity} shares of ${ticker} @ $${price.toFixed(2)}.`;
        success = true;
    } 
    else if (type === 'SELL') {
        if (!holding || holding.quantity < quantity) {
            tradeMsg = `Trade failed: You only hold ${holding ? holding.quantity : 0} shares of ${ticker}.`;
            return { portfolio, tradeMsg, success: false };
        }
        holding.quantity -= quantity;
        if (holding.quantity === 0) {
            portfolio = portfolio.filter(h => h.ticker !== ticker);
        }
        tradeMsg = `Successfully sold ${quantity} shares of ${ticker} @ $${price.toFixed(2)}.`;
        success = true;
    }
    return { portfolio, tradeMsg, success };
};

// ✅ UPDATED: Saves trade to transaction history on success
const processTrade = async (userId, ticker, quantity, type) => {
    const user = await User.findById(userId);
    if (!user) return;

    const currentPrice = STOCKS[ticker];
    const totalValue = quantity * currentPrice;
    let tradeMsg;
    let success = false;
    
    if (type === 'BUY') {
        if (user.cash >= totalValue) {
            user.cash -= totalValue;
            const res = updatePortfolio(user.portfolio, ticker, quantity, 'BUY', currentPrice);
            user.portfolio = res.portfolio;
            tradeMsg = res.tradeMsg;
            success = res.success;
        } else {
            tradeMsg = `Trade failed: Insufficient cash ($${user.cash.toFixed(2)}).`;
        }
    } 
    else if (type === 'SELL') {
        const res = updatePortfolio(user.portfolio, ticker, quantity, 'SELL', currentPrice);
        if (res.success) {
            user.cash += totalValue;
            user.portfolio = res.portfolio;
            success = true;
        }
        tradeMsg = res.tradeMsg;
    }
    
    // ✅ SAVE TRANSACTION IF SUCCESSFUL
    if (success) {
        user.transactions.push({
            action: type,
            ticker: ticker,
            quantity: quantity,
            price: currentPrice,
            tradeValue: totalValue
        });
    }

    await user.save();
    
    const connection = activeConnections.get(userId);
    if (connection) {
        connection.ws.send(JSON.stringify({
            type: 'PORTFOLIO_UPDATE',
            cash: user.cash,
            portfolio: formatPortfolioForClient(user.portfolio),
            tradeMsg: tradeMsg
        }));
    }
};

const handleSubscription = async (userId, ticker, action) => {
    const user = await User.findById(userId);
    const connection = activeConnections.get(userId);
    if (!user || !connection) return;
    
    const subsSet = connection.subscribed;
    if (action === 'ADD' && !subsSet.has(ticker)) {
        subsSet.add(ticker);
        user.subscriptions.push(ticker);
    } else if (action === 'REMOVE' && subsSet.has(ticker)) {
        subsSet.delete(ticker);
        user.subscriptions = user.subscriptions.filter(sub => sub !== ticker);
    }
    await user.save();
};

const handleAlert = async (userId, ticker, threshold) => {
    const user = await User.findById(userId);
    const connection = activeConnections.get(userId);
    if (!user || !connection) return;

    user.alerts.set(ticker, threshold);
    await user.save();
    
    connection.ws.send(JSON.stringify({
        type: 'ALERT_SET_SUCCESS',
        activeAlerts: Object.fromEntries(user.alerts),
        tradeMsg: `Successfully set alert for ${ticker} below $${threshold.toFixed(2)}.`
    }));
};

const checkAndTriggerAlerts = async (ticker, newPrice) => {
    for (const [userId, connection] of activeConnections.entries()) {
        const user = await User.findById(userId);
        if (!user) continue;

        const threshold = user.alerts.get(ticker);
        if (threshold && newPrice <= threshold) {
            user.alerts.delete(ticker);
            await user.save();
            
            connection.ws.send(JSON.stringify({
                type: 'ALERT_TRIGGERED',
                alerts: [{ ticker, price: newPrice, threshold }],
                activeAlerts: Object.fromEntries(user.alerts)
            }));
        }
    }
};

const formatPortfolioForClient = (dbPortfolio) => {
    const portfolioMap = {};
    dbPortfolio.forEach(holding => {
        if (holding.quantity > 0) {
             portfolioMap[holding.ticker] = {
                quantity: holding.quantity,
                avgPrice: holding.avgPrice
            };
        }
    });
    return portfolioMap;
}

const calculateRiskMetrics = (portfolio) => {
    const stockCount = portfolio.filter(h => h.quantity > 0).length;
    const totalStocks = SUPPORTED_STOCKS.length;
    let diversificationScore = 75;
    if (stockCount > 0) {
        diversificationScore = Math.min(100, (stockCount / totalStocks) * 100 + 50);
    }
    const beta = PORTFOLIO_BETA_BASE + ((MARKET_INDEX - 1000) / 1000) * 0.1;
    return {
        marketIndex: MARKET_INDEX.toFixed(2),
        portfolioBeta: beta.toFixed(2),
        diversificationScore: diversificationScore.toFixed(0) 
    };
};

// --- Real-Time Simulation and Broadcast ---

const simulatePriceUpdate = () => {
    let marketChange = (Math.random() - 0.5) * 0.1; 
    MARKET_INDEX += MARKET_INDEX * marketChange;
    MARKET_INDEX = Math.max(800, MARKET_INDEX); 
    
    const newPrices = {};
    SUPPORTED_STOCKS.forEach(ticker => {
        let price = STOCKS[ticker];
        let drift = (Math.random() - 0.5) * 0.5; 
        price += price * (drift * 0.005 + marketChange);
        price = Math.max(10, price); 
        STOCKS[ticker] = price;
        newPrices[ticker] = price;
        checkAndTriggerAlerts(ticker, price);
    });
    return newPrices;
};

const broadcastPrices = async () => {
    const newPrices = simulatePriceUpdate(); 
    
    for (const [userId, connection] of activeConnections.entries()) {
        const { ws } = connection;
        
        // ✅ FIX: Send ALL prices to everyone.
        // This ensures charts work immediately for any stock they click on.
        // The frontend will still only "flash" the rows for subscribed stocks.
        const allPrices = newPrices;
        
        if (ws.readyState === ws.OPEN) {
            const user = await User.findById(userId);
            if (user) {
                const riskMetrics = calculateRiskMetrics(user.portfolio);
                ws.send(JSON.stringify({
                    type: 'PRICE_UPDATE',
                    data: allPrices, // Sending all data
                    cash: user.cash,
                    portfolio: formatPortfolioForClient(user.portfolio),
                    activeAlerts: user.alerts ? Object.fromEntries(user.alerts) : {},
                    riskMetrics: riskMetrics 
                }));
            }
        }
    }
};
setInterval(broadcastPrices, 1000);

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Authentication API endpoints ready.`);
});