const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://mpesa-wifi-backend.onrender.com';

// In-memory store for active payment sessions
const activeTransactions = {};

// Helper: Normalize phone numbers to international standard (254XXXXXXXXX)
function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

// Helper: Generate a random 6-digit voucher code
function generateVoucherCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper: Get Safaricom OAuth Token
async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const response = await axios.get(
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend is active' });
});

// 1. Initiate STK Push
app.post('/api/stkpush', async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const formattedPhone = normalizePhone(phone);

    if (!formattedPhone || formattedPhone.length !== 12) {
      return res.status(400).json({ success: false, error: 'Invalid M-Pesa phone number format.' });
    }

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Reset/Initialize transaction state for this phone number
    activeTransactions[formattedPhone] = {
      status: 'PENDING',
      voucherCode: null,
      timestamp: Date.now()
    };

    const stkData = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: `${RENDER_URL}/api/mpesa-callback`,
      AccountReference: 'WiFiPass',
      TransactionDesc: 'WiFi Package Purchase'
    };

    const response = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      stkData,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (response.data.ResponseCode === '0') {
      return res.json({ success: true, message: 'STK Push sent successfully.' });
    } else {
      activeTransactions[formattedPhone].status = 'FAILED';
      return res.status(400).json({ success: false, error: 'Failed to initiate STK push.' });
    }
  } catch (error) {
    console.error('STK Push Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ success: false, error: 'Internal server error triggering payment.' });
  }
});

// 2. M-Pesa Callback (Hit by Safaricom Servers)
app.post('/api/mpesa-callback', (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;
    if (!callbackData) {
      return res.json({ ResultCode: 1, ResultDesc: 'Invalid Payload' });
    }

    const resultCode = callbackData.ResultCode;
    let phone = '';

    // Extract phone number from callback metadata
    const items = callbackData.CallbackMetadata?.Item || [];
    const phoneItem = items.find(item => item.Name === 'PhoneNumber');
    if (phoneItem && phoneItem.Value) {
      phone = normalizePhone(phoneItem.Value);
    }

    if (phone && activeTransactions[phone]) {
      if (resultCode === 0) {
        // Successful payment
        const newVoucher = generateVoucherCode();
        activeTransactions[phone] = {
          status: 'SUCCESS',
          voucherCode: newVoucher,
          timestamp: Date.now()
        };
        console.log(`Payment SUCCESS for ${phone}. Generated Voucher: ${newVoucher}`);
      } else {
        // Cancelled or Failed
        activeTransactions[phone].status = 'FAILED';
        console.log(`Payment FAILED/CANCELLED for ${phone}. ResultCode: ${resultCode}`);
      }
    }

    // Always respond to Safaricom with 200 OK
    res.json({ ResultCode: 0, ResultDesc: 'Callback received successfully' });
  } catch (err) {
    console.error('Callback Error:', err.message);
    res.json({ ResultCode: 0, ResultDesc: 'Handled with errors' });
  }
});

// 3. Poll Payment Status (Polled by Portal frontend)
app.get('/api/payment-status', (req, res) => {
  const formattedPhone = normalizePhone(req.query.phone);
  const session = activeTransactions[formattedPhone];

  if (!session) {
    return res.json({ status: 'PENDING' });
  }

  if (session.status === 'SUCCESS') {
    const responseData = { status: 'SUCCESS', voucherCode: session.voucherCode };
    // Remove session after successful retrieval so it won't auto-login again
    delete activeTransactions[formattedPhone];
    return res.json(responseData);
  }

  return res.json({ status: session.status });
});

// 4. Switch Device Access Endpoint
app.post('/api/switch-device', (req, res) => {
  const formattedPhone = normalizePhone(req.body.phone);
  const session = activeTransactions[formattedPhone];

  if (session && session.status === 'SUCCESS') {
    return res.json({
      success: true,
      voucherCode: session.voucherCode,
      message: 'Active plan found! Transferring access...'
    });
  }

  return res.status(410).json({
    success: false,
    message: 'No active plan found for this phone number.'
  });
});

app.listen(PORT, () => {
  console.log(`Render Server active on port ${PORT}`);
});