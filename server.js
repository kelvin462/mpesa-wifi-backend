const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// Explicit CORS Configuration to allow requests from local captive portal
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory data stores for active sessions & transactions
const payments = {}; 
const activeUsers = {}; 

// Helper function to format phone numbers to 254XXXXXXXXX
function formatPhone(phone) {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

// Generate Daraja OAuth Token
async function getMpesaToken() {
  const credentials = `${process.env.CONSUMER_KEY.trim()}:${process.env.CONSUMER_SECRET.trim()}`;
  const auth = Buffer.from(credentials).toString('base64');
  
  const response = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'User-Agent': 'NodeJS-Mpesa-Client'
      }
    }
  );
  return response.data.access_token;
}

// Root ping endpoint to verify deployment & wake up Render instance
app.get('/', (req, res) => {
  res.status(200).send('M-Pesa WiFi Backend is Online and Ready.');
});

// Health check endpoint for index.html connection self-test
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Backend connected successfully!' });
});

// 1. Trigger M-Pesa STK Push
app.post('/api/stkpush', async (req, res) => {
  const { phone, amount, duration } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ success: false, error: 'Phone number and amount are required' });
  }

  const formattedPhone = formatPhone(phone);
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${process.env.BUSINESS_SHORTCODE.trim()}${process.env.PASSKEY.trim()}${timestamp}`
  ).toString('base64');

  try {
    const token = await getMpesaToken();

    const payload = {
      BusinessShortCode: process.env.BUSINESS_SHORTCODE.trim(),
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(Number(amount)),
      PartyA: formattedPhone,
      PartyB: process.env.BUSINESS_SHORTCODE.trim(),
      PhoneNumber: formattedPhone,
      CallBackURL: `${process.env.CALLBACK_URL.trim()}/api/mpesa-callback`,
      AccountReference: 'WiFi Access',
      TransactionDesc: `WiFi Access Pass - ${duration || ''}`
    };

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log('[STK PUSH SUCCESS]', response.data);
    
    // Store request metadata for callback reference
    payments[formattedPhone] = { 
      status: 'PENDING', 
      amount: Number(amount), 
      duration: duration || '30 Minutes' 
    };

    return res.json({ success: true, message: 'STK Push sent successfully', data: response.data });
  } catch (error) {
    console.error('--- DARAJA ERROR DETAILS ---');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error Message:', error.message);
    }
    return res.status(500).json({ success: false, error: 'Failed to trigger M-Pesa push' });
  }
});

// 2. Safaricom M-Pesa Callback Endpoint
app.post('/api/mpesa-callback', (req, res) => {
  // Always acknowledge Safaricom with 200 OK immediately
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    console.log('=== M-PESA CALLBACK RECEIVED ===');
    console.log(JSON.stringify(req.body, null, 2));

    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const resultCode = callback.ResultCode;

    if (resultCode === 0) {
      const items = callback.CallbackMetadata?.Item || [];
      const phoneItem = items.find(i => i.Name === 'PhoneNumber');
      const amountItem = items.find(i => i.Name === 'Amount');
      
      const phone = phoneItem ? formatPhone(phoneItem.Value) : null;
      const paidAmount = amountItem ? Number(amountItem.Value) : 0;

      if (phone) {
        let voucherData = [];
        const vouchersFilePath = path.join(__dirname, 'vouchers.json');
        
        if (fs.existsSync(vouchersFilePath)) {
          try {
            voucherData = JSON.parse(fs.readFileSync(vouchersFilePath, 'utf8'));
          } catch (err) {
            console.error('Error reading vouchers.json:', err.message);
          }
        }

        // Find matching package or fallback to first package
        const matchedPkg = voucherData.find(p => p.amount === paidAmount) || voucherData[0];
        
        let assignedVoucher = 'M4IQi';
        if (matchedPkg && matchedPkg.voucherCodes && matchedPkg.voucherCodes.length > 0) {
          assignedVoucher = matchedPkg.voucherCodes.shift();
        }

        const durationMins = matchedPkg ? matchedPkg.durationMinutes : 30;
        const expiresAt = Date.now() + (durationMins * 60 * 1000);

        payments[phone] = {
          status: 'SUCCESS',
          amount: paidAmount,
          voucherCode: assignedVoucher
        };

        activeUsers[phone] = {
          voucherCode: assignedVoucher,
          expiresAt: expiresAt
        };

        console.log(`[PAYMENT SUCCESS] Phone: ${phone} | Amount: KES ${paidAmount} | Voucher: ${assignedVoucher}`);
      }
    } else {
      console.log(`[PAYMENT CANCELLED/FAILED] Reason: ${callback.ResultDesc}`);
      // Mark transaction status as failed if phone context is present
      const items = callback.CallbackMetadata?.Item || [];
      const phoneItem = items.find(i => i.Name === 'PhoneNumber');
      if (phoneItem) {
        const phone = formatPhone(phoneItem.Value);
        payments[phone] = { status: 'FAILED' };
      }
    }
  } catch (err) {
    console.error('Error processing callback payload:', err.message);
  }
});

// 3. Poll Payment Status Endpoint
app.get('/api/payment-status', (req, res) => {
  const phone = formatPhone(req.query.phone || '');
  const record = payments[phone];

  if (record) {
    res.json(record);
  } else {
    res.json({ status: 'PENDING' });
  }
});

// 4. Switch Device Endpoint
app.post('/api/switch-device', (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  const formattedPhone = formatPhone(phone);
  const session = activeUsers[formattedPhone];

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'No active internet plan found for this number. Please buy a package.'
    });
  }

  if (Date.now() > session.expiresAt) {
    delete activeUsers[formattedPhone];
    return res.status(410).json({
      success: false,
      message: 'Your plan has expired. Please purchase a new package.'
    });
  }

  return res.json({
    success: true,
    voucherCode: session.voucherCode,
    message: 'Active plan found! Transferring access to this device...'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));