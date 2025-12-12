// models/User.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Schema for a single holding (e.g., 10 GOOG @ $2800)
const HoldingSchema = new mongoose.Schema({
    ticker: { type: String, required: true },
    quantity: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
}, { _id: false }); // We don't need MongoDB IDs for sub-documents

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    cash: { type: Number, default: 100000.00 }, // Initial starting cash
    
    // Portfolio Holdings (replaces userPortfolio Map)
    portfolio: [HoldingSchema],
    
    // User Subscriptions (replaces userSubscriptions Map)
    subscriptions: [{ type: String, default: [] }],

    // Price Alerts (replaces userAlerts Map)
    alerts: { type: Map, of: Number, default: {} },
});

// Priority 2: Pre-save hook to hash password before creation/update (Security)
UserSchema.pre('save', async function (next) {
    if (!this.isModified('password')) {
        return next();
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Priority 2: Method to compare entered password with hashed password
UserSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

const User = mongoose.model('User', UserSchema);

export default User;