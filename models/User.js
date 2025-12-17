// models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Schema for a single holding
const HoldingSchema = new mongoose.Schema({
    ticker: { type: String, required: true },
    quantity: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
}, { _id: false }); 

// NEW: Schema for Transaction History
const TransactionSchema = new mongoose.Schema({
    action: { type: String, required: true }, // 'BUY' or 'SELL'
    ticker: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    tradeValue: { type: Number, required: true }, // Store the total dollar value
    date: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    cash: { type: Number, default: 100000.00 },
    
    // Portfolio Holdings 
    portfolio: [HoldingSchema],
    
    // User Subscriptions 
    subscriptions: [{ type: String, default: [] }],

    // Price Alerts 
    alerts: { type: Map, of: Number, default: {} },

    // NEW: Transaction History storage
    transactions: [TransactionSchema] 
});

// Pre-save hook to hash password
UserSchema.pre('save', async function (next) {
    if (!this.isModified('password')) {
        return next();
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Method to compare entered password
UserSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', UserSchema);

export default User;