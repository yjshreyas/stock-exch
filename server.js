// server.js (New Entry File)
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

// Database Imports
import connectDB from './db.js';
import User from './models/User.js'; 
// Routes Import
import authRoutes from './routes/auth.js'; 

dotenv.config();
connectDB(); // CRITICAL: Connect to MongoDB on startup

// --- Configuration & Global Data ---
const PORT = process.env.PORT || 3000;
const __dirname = path.resolve();
const JWT_SECRET = process.env.JWT_SECRET;
const SUPPORTED_STOCKS = ['GOOG', 'TSLA', 'AMZN', 'META', 'NVDA'];


// Stock Prices (Keep these in memory for real-time updates)
let STOCKS = {}; // Price data will be stored here
SUPPORTED_STOCKS.forEach(ticker => {
    STOCKS[ticker] = 100 + Math.random() * 200; // Initial random price
});


// Market Metrics (Simulated)
let MARKET_INDEX = 1000.0;
let PORTFOLIO_BETA_BASE = 1.2;
let DIVERSIFICATION_SCORE_BASE = 75;


// --- Data Stores (ONLY live WebSocket connections remain in memory) ---
// Stores userId (from DB) -> { ws: wsObject, email: string, subscribed: Set<string> }
const activeConnections = new Map(); 

// --- Server Setup (Express for API & Static Files) ---
const app = express();
const server = createServer(app);
// CRITICAL: Prevent the WS server from running on the main port until Express is set up.
const wss = new WebSocketServer({ noServer: true }); 


// Middleware
app.use(express.json()); // Essential for parsing API request bodies

// Serve static HTML and setup API routes
app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Routes (Mount the authentication endpoints)
app.use('/api/auth', authRoutes);


// --- WebSocket Logic: Authentication & Upgrade ---

// JWT Validation Middleware
const authenticateWS = (token) => {
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded;
    } catch (err) {
        return null; // Invalid token
    }
};

server.on('upgrade', async (request, socket, head) => {
    // 1. Extract token from URL (e.g., ws://localhost:3000/?token=...)
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    
    // 2. Authenticate the token
    const authPayload = authenticateWS(token);

    if (!authPayload) {
        console.log('WS: Auth failed for connection attempt.');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    // 3. Attach the authenticated user data to the request object
    request.userId = authPayload.id;
    request.userEmail = authPayload.email;

    // 4. Handle the upgrade process to WebSocket
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});


wss.on('connection', async (ws, req) => {
    const userId = req.userId;
    const email = req.userEmail;

    // 1. Initial State Check
    if (activeConnections.has(userId)) {
        // If user is already connected, close the old connection
        activeConnections.get(userId).ws.close(1000, 'New connection established.');
        activeConnections.delete(userId);
    }
    
    // 2. Load User Data from DB
    let user = await User.findById(userId);

    if (!user) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'User not found.' }));
        ws.close();
        return;
    }
    
    // 3. Store the new connection and its state
    const subscribed = new Set(user.subscriptions || SUPPORTED_STOCKS); // Default to all
    activeConnections.set(userId, { ws, email, subscribed });
    
    // 4. Send INIT message (Client dashboard setup)
    const initialData = {
        type: 'INIT',
        email: user.email,
        cash: user.cash,
        portfolio: formatPortfolioForClient(user.portfolio),
        stocks: STOCKS,
        subscriptions: Array.from(subscribed),
        activeAlerts: Object.fromEntries(user.alerts),
        riskMetrics: calculateRiskMetrics(user.portfolio)
    };
    ws.send(JSON.stringify(initialData));

    // 5. Handle incoming messages
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const userState = activeConnections.get(userId);
            
            if (!userState) return; // Should not happen after connection

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
                default:
                    console.log(`Unknown message type: ${data.type}`);
            }
        } catch (e) {
            console.error('WS Message parsing error:', e);
        }
    });

    ws.on('close', () => {
        activeConnections.delete(userId);
        console.log(`User ${email} disconnected. Active: ${activeConnections.size}`);
    });
});


// --- Core DB/Business Logic Functions (AWAIT calls to DB) ---

/**
 * Helper to update a user's portfolio holding.
 * @returns {object} { portfolio: Holding[], tradeMsg: string }
 */
const updatePortfolio = (portfolio, ticker, quantity, type, price) => {
    let tradeMsg = '';
    
    let holding = portfolio.find(h => h.ticker === ticker);
    
    if (type === 'BUY') {
        const totalCost = quantity * price;
        
        if (holding) {
            // Update average price for existing holding
            const newTotalQty = holding.quantity + quantity;
            const newTotalCost = (holding.quantity * holding.avgPrice) + totalCost;
            holding.avgPrice = newTotalCost / newTotalQty;
            holding.quantity = newTotalQty;
        } else {
            // New holding
            portfolio.push({ ticker, quantity, avgPrice: price });
        }
        tradeMsg = `Successfully bought ${quantity} shares of ${ticker} @ $${price.toFixed(2)}.`;
    } 
    else if (type === 'SELL') {
        if (!holding || holding.quantity < quantity) {
            tradeMsg = `Trade failed: You only hold ${holding ? holding.quantity : 0} shares of ${ticker}.`;
            return { portfolio, tradeMsg };
        }
        
        // Simple FIFO/LIFO is complex. For simplicity, just reduce quantity.
        holding.quantity -= quantity;
        
        if (holding.quantity === 0) {
            // Remove holding if quantity is zero (optional, but cleaner)
            portfolio = portfolio.filter(h => h.ticker !== ticker);
        }
        tradeMsg = `Successfully sold ${quantity} shares of ${ticker} @ $${price.toFixed(2)}.`;
    }
    return { portfolio, tradeMsg };
};


/**
 * Processes a trade request against the user's cash and updates the database.
 */
const processTrade = async (userId, ticker, quantity, type) => {
    const user = await User.findById(userId);
    const currentPrice = STOCKS[ticker];
    const totalValue = quantity * currentPrice;
    let tradeMsg;
    
    if (!user) return;

    if (type === 'BUY') {
        if (user.cash >= totalValue) {
            user.cash -= totalValue;
            const { portfolio, msg } = updatePortfolio(user.portfolio, ticker, quantity, 'BUY', currentPrice);
            user.portfolio = portfolio;
            tradeMsg = msg;
        } else {
            tradeMsg = `Trade failed: Insufficient cash ($${user.cash.toFixed(2)} available) to buy $${totalValue.toFixed(2)} worth of ${ticker}.`;
        }
    } 
    else if (type === 'SELL') {
        const holding = user.portfolio.find(h => h.ticker === ticker);
        
        if (holding && holding.quantity >= quantity) {
            user.cash += totalValue;
            const { portfolio, msg } = updatePortfolio(user.portfolio, ticker, quantity, 'SELL', currentPrice);
            user.portfolio = portfolio;
            tradeMsg = msg;
        } else {
            tradeMsg = `Trade failed: You do not own ${quantity} shares of ${ticker}.`;
        }
    }
    
    await user.save();
    
    // Notify the client of the portfolio update
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


/**
 * Handles subscription toggling and updates the database.
 */
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
    // No need to send confirmation, client updates state based on its own action.
};

/**
 * Sets a price alert and updates the database.
 */
const handleAlert = async (userId, ticker, threshold) => {
    const user = await User.findById(userId);
    const connection = activeConnections.get(userId);
    
    if (!user || !connection) return;

    // Use Mongoose Map setters to update the alert
    user.alerts.set(ticker, threshold);
    await user.save();
    
    // Notify the client
    const updatedAlerts = Object.fromEntries(user.alerts);
    connection.ws.send(JSON.stringify({
        type: 'ALERT_SET_SUCCESS',
        activeAlerts: updatedAlerts,
        tradeMsg: `Successfully set alert for ${ticker} below $${threshold.toFixed(2)}.`
    }));
};

/**
 * Checks for triggered alerts and updates the database and client.
 */
const checkAndTriggerAlerts = async (ticker, newPrice) => {
    const triggeredAlerts = [];
    
    for (const [userId, connection] of activeConnections.entries()) {
        const user = await User.findById(userId);
        
        if (!user) continue;

        // Check if the user has an alert for this ticker
        const threshold = user.alerts.get(ticker);
        
        if (threshold && newPrice <= threshold) {
            triggeredAlerts.push({ ticker, price: newPrice.toFixed(2), threshold: threshold.toFixed(2) });
            
            // Remove the triggered alert from the user's database entry
            user.alerts.delete(ticker);
            await user.save();
            
            // Notify the client immediately
            connection.ws.send(JSON.stringify({
                type: 'ALERT_TRIGGERED',
                alerts: [{ ticker, price: newPrice, threshold }],
                activeAlerts: Object.fromEntries(user.alerts)
            }));
        }
    }
};

// --- Utility Functions ---

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
    // This is a highly simplified simulation
    const stockCount = portfolio.filter(h => h.quantity > 0).length;
    const totalStocks = SUPPORTED_STOCKS.length;
    
    let diversificationScore = DIVERSIFICATION_SCORE_BASE;
    if (stockCount > 0) {
        diversificationScore = Math.min(100, (stockCount / totalStocks) * 100 + 50);
    }
    
    // Simple Beta (Higher if concentrated on volatile stocks, here just uses market index)
    const beta = PORTFOLIO_BETA_BASE + ((MARKET_INDEX - 1000) / 1000) * 0.1;
    
    return {
        marketIndex: MARKET_INDEX.toFixed(2),
        portfolioBeta: beta.toFixed(2),
        diversificationScore: diversificationScore.toFixed(0) 
    };
};

// --- Real-Time Simulation and Broadcast ---

const simulatePriceUpdate = () => {
    let marketChange = (Math.random() - 0.5) * 0.1; // -0.05% to +0.05%
    MARKET_INDEX += MARKET_INDEX * marketChange;
    MARKET_INDEX = Math.max(800, MARKET_INDEX); // Prevent crash
    
    const newPrices = {};
    
    SUPPORTED_STOCKS.forEach(ticker => {
        // Apply a base drift + a market influence
        let price = STOCKS[ticker];
        let drift = (Math.random() - 0.5) * 0.5; // +/- 0.5
        let volatility = 0.005; 
        
        price += price * (drift * volatility + marketChange);
        
        // Ensure price doesn't go below a floor
        price = Math.max(10, price); 
        
        STOCKS[ticker] = price;
        newPrices[ticker] = price;

        // Check alerts
        checkAndTriggerAlerts(ticker, price);
    });
    return newPrices;
};

const broadcastPrices = async () => {
    const newPrices = simulatePriceUpdate(); 
    
    // Iterate over all active connections
    for (const [userId, connection] of activeConnections.entries()) {
        const { ws, subscribed } = connection;
        
        // Only send prices for subscribed stocks
        const subscribedPrices = {};
        let needsUpdate = false;
        
        subscribed.forEach(ticker => {
            if (newPrices[ticker]) {
                subscribedPrices[ticker] = newPrices[ticker];
                needsUpdate = true;
            }
        });
        
        if (ws.readyState === ws.OPEN && needsUpdate) {
            // Fetch the latest user state (cash, portfolio, alerts)
            const user = await User.findById(userId);
            
            if (user) {
                const riskMetrics = calculateRiskMetrics(user.portfolio);
                
                ws.send(JSON.stringify({
                    type: 'PRICE_UPDATE',
                    data: subscribedPrices,
                    cash: user.cash,
                    portfolio: formatPortfolioForClient(user.portfolio),
                    activeAlerts: Object.fromEntries(user.alerts),
                    riskMetrics: riskMetrics 
                }));
            }
        }
    }
};

// Real-time interval (1 second)
setInterval(broadcastPrices, 1000);


// --- Server Start ---
// server.listen(PORT, () => {
//     console.log(`Server running on http://localhost:${PORT}`);
//     console.log(`Authentication API endpoints ready.`);
// });

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Authentication API endpoints ready.`);
});