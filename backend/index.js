import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Replace with your MongoDB Atlas connection string
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/buyersdb';

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
  const buyers = await Buyer.find();
  res.json(buyers);
});

// Add or update multiple buyers (bulk upsert)
app.post('/api/buyers', async (req, res) => {
  const buyers = req.body;
  const ops = buyers.map(b => ({
    updateOne: {
      filter: { buyer: b.buyer },
      update: { $set: b },
      upsert: true
    }
  }));
  await Buyer.bulkWrite(ops);
  res.json({ success: true });
});

// Update a single buyer's manual fields
app.patch('/api/buyers/:buyer', async (req, res) => {
  const { buyer } = req.params;
  const { receivedAmount, paymentMode } = req.body;
  await Buyer.updateOne(
    { buyer },
    { $set: { receivedAmount, paymentMode } }
  );
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
