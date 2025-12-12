// routes/auth.js
import express from 'express';
import { body, validationResult } from 'express-validator';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = express.Router();

// Utility to generate JWT token
const generateToken = (id, email) => {
    return jwt.sign({ id, email }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post(
    '/register',
    [
        body('email', 'Please include a valid email').isEmail(),
        body('password', 'Password must be 6 or more characters').isLength({ min: 6 }),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;

        try {
            let user = await User.findOne({ email });

            if (user) {
                return res.status(400).json({ msg: 'User already exists' });
            }

            user = new User({ email, password });

            // Password hashing happens in the User model pre-save hook
            await user.save();

            const token = generateToken(user._id, user.email);
            res.status(201).json({ token, email: user.email });

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Server Error');
        }
    }
);

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post(
    '/login',
    [
        body('email', 'Please include a valid email').isEmail(),
        body('password', 'Password is required').exists(),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password } = req.body;

        try {
            const user = await User.findOne({ email });

            if (!user) {
                return res.status(401).json({ msg: 'Invalid Credentials' });
            }

            const isMatch = await user.matchPassword(password);

            if (!isMatch) {
                return res.status(401).json({ msg: 'Invalid Credentials' });
            }

            const token = generateToken(user._id, user.email);
            res.json({ token, email: user.email });

        } catch (err) {
            console.error(err.message);
            res.status(500).send('Server Error');
        }
    }
);

export default router;