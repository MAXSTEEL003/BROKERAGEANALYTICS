import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Replace with your MongoDB Atlas connection string
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/buyersdb';

// Fail fast if DB is not reachable instead of hanging requests forever
mongoose.set('bufferCommands', false);

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const buyerSchema = new mongoose.Schema({
  buyer: { type: String, required: true },
  place: String,
  totalQtls: Number,
  commission: Number,
  receivedAmount: String,
  paymentMode: String
}, { timestamps: true });

const Buyer = mongoose.model('Buyer', buyerSchema);

// Get all buyers
app.get('/api/buyers', async (req, res) => {
  try {
    const buyers = await Buyer.find().lean();
    res.json(buyers);
  } catch (err) {
    console.error('GET /api/buyers error:', err);
    res.status(500).json({ error: 'db_error', message: 'Failed to fetch buyers' });
  }
});

// Add or update multiple buyers (bulk upsert)
app.post('/api/buyers', async (req, res) => {
  try {
    const buyers = req.body || [];
    if (!Array.isArray(buyers)) return res.status(400).json({ error: 'invalid_body' });
    const ops = buyers.map(b => ({
      updateOne: {
        filter: { buyer: b.buyer },
        update: { $set: b },
        upsert: true
      }
    }));
    if (ops.length) await Buyer.bulkWrite(ops);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/buyers error:', err);
    res.status(500).json({ error: 'db_error', message: 'Failed to upsert buyers' });
  }
});

// Update a single buyer's manual fields
app.patch('/api/buyers/:buyer', async (req, res) => {
  try {
    const { buyer } = req.params;
    const { receivedAmount, paymentMode } = req.body || {};
    await Buyer.updateOne(
      { buyer },
      { $set: { receivedAmount, paymentMode } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/buyers/:buyer error:', err);
    res.status(500).json({ error: 'db_error', message: 'Failed to update buyer' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
