# Buyer Backend API

## Setup

1. Copy `.env.example` to `.env` and fill in your MongoDB Atlas connection string.
2. Run `npm install` in the backend folder.
3. Start the server with `npm run dev` (for development) or `npm start` (for production).

## API Endpoints

- `GET /api/buyers` — Get all buyers
- `POST /api/buyers` — Bulk upsert buyers (array of buyers)
- `PATCH /api/buyers/:buyer` — Update manual fields for a buyer

## Example MongoDB Atlas URI
```
MONGO_URI=mongodb+srv://<username>:<password>@<cluster-url>/buyersdb?retryWrites=true&w=majority
```

---

You can deploy this backend to Render, Railway, or any Node.js hosting provider.
