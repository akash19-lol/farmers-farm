const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  if (process.env.NODE_ENV === 'production') throw new Error('Cloudinary environment variables are missing.');
  console.warn('WARNING: Cloudinary environment variables are missing.');
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dummy',
  api_key: process.env.CLOUDINARY_API_KEY || 'dummy',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'dummy'
});

// Multer Setup for In-Memory Uploads (Reviews)
const reviewStorage = multer.memoryStorage();
const reviewUpload = multer({
  storage: reviewStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});
// OTP Storage (Email -> { otp, expiresAt })
const otpStorage = new Map();

// NodeMailer SMTP Setup (strict timeouts so blocked free-tier SMTP never hangs forever)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  connectionTimeout: 7000,
  greetingTimeout: 7000,
  socketTimeout: 9000
});

/**
 * Send transactional emails over HTTPS APIs first (required on Render free tier where
 * outbound SMTP ports 25/465/587 are blocked), falling back to Nodemailer SMTP locally.
 */
async function sendEmail({ to, subject, html, text }) {
  const senderEmail = (process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER || 'noreply@farmersfarm.in').trim();

  if (process.env.BREVO_API_KEY) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': process.env.BREVO_API_KEY.trim()
      },
      body: JSON.stringify({
        sender: { name: 'Farmers Farm', email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text || subject
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Brevo API error (${res.status}): ${errText}`);
    }
    return 'brevo';
  }

  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY.trim()}`
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || `Farmers Farm <onboarding@resend.dev>`,
        to: [to],
        subject,
        html,
        text: text || subject
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Resend API error (${res.status}): ${errText}`);
    }
    return 'resend';
  }

  if (process.env.EMAIL_WEBHOOK_URL) {
    const res = await fetch(process.env.EMAIL_WEBHOOK_URL.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({
        to,
        subject,
        html,
        text: text || subject,
        secret: process.env.EMAIL_WEBHOOK_SECRET || ''
      }),
      signal: AbortSignal.timeout(18000)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Email webhook error (${res.status}): ${errText}`);
    }
    const webhookData = await res.json().catch(() => null);
    if (webhookData && webhookData.ok === false) {
      throw new Error(webhookData.error || 'Email webhook rejected request');
    }
    return 'webhook';
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('Email credentials are not configured on server.');
  }

  await transporter.sendMail({
    from: `"Farmers Farm" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html,
    text
  });
  return 'smtp';
}

/**
 * Upload an image buffer to Cloudinary first, falling back to persistent inline data URL
 * on ephemeral cloud hosts (for smaller images) or local disk for development.
 */
async function uploadImageAsset(file, folder = 'farmers-farm', localSubdir = 'images/uploads') {
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder }, (error, uploadResult) => {
        if (uploadResult) resolve(uploadResult);
        else reject(error);
      });
      stream.end(file.buffer);
    });
    if (result && result.secure_url) {
      return result.secure_url;
    }
  } catch (err) {
    console.warn(`Cloudinary upload warning (${folder}):`, err?.message || err);
  }

  // On Render's ephemeral disk, inline small images (<650KB) as data URIs so they persist across redeploys
  if (process.env.RENDER && file.buffer && file.buffer.length <= 650 * 1024 && file.mimetype) {
    return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  }

  const uploadsDir = path.join(__dirname, '../../public', localSubdir);
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const safeName = `${Date.now()}-${(file.originalname || 'upload.png').replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  fs.writeFileSync(path.join(uploadsDir, safeName), file.buffer);
  return `/${localSubdir.replace(/\\/g, '/')}/${safeName}`;
}

// Google Auth Setup (dynamically reads env so runtime updates work cleanly)
function getGoogleClientId() {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!id || id === 'YOUR_GOOGLE_CLIENT_ID_HERE') return '';
  return id;
}

function sanitizeCustomer(customer) {
  if (!customer) return customer;
  const { password, ...safe } = customer;
  return safe;
}

router.get('/auth/config', (req, res) => {
  const googleClientId = getGoogleClientId();
  res.json({
    googleClientId,
    googleConfigured: Boolean(googleClientId)
  });
});

// --- EMAIL NOTIFICATION SERVICE ---
const sendOrderEmail = async (toEmail, subject, text) => {
  console.log(`[EMAIL INITIATED] Attempting to send email to: ${toEmail}`);
  if (!toEmail) {
    console.log('[EMAIL ABORTED] No email address provided.');
    return;
  }
  try {
    const htmlContent = text.replace(/\n/g, '<br>');
    const via = await sendEmail({
      to: toEmail,
      subject,
      html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
              <h2 style="color: #2D5A27;">Farmers Farm</h2>
              <p>${htmlContent}</p>
             </div>`,
      text
    });
    console.log(`✉️ [EMAIL SENT via ${via}] Successfully sent to ${toEmail}`);
  } catch (err) {
    console.error(`✉️ [EMAIL FAILED] Could not send to ${toEmail}:`, err?.message || err);
  }
};

// Initialize Firebase Admin
const { admin, db } = require('../firebase');

// Setup Multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

// Initialize Razorpay (optional - COD mode works without keys)
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn('WARNING: Razorpay keys are missing. Running in COD-only mode.');
}
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy',
});

// Admin Token Setup
if (!process.env.ADMIN_TOKEN_SECRET) {
  if (process.env.NODE_ENV === 'production') throw new Error('ADMIN_TOKEN_SECRET is missing.');
  console.warn('WARNING: ADMIN_TOKEN_SECRET is missing.');
}
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'ff_super_secret_token_2026';

// --- ADMIN LOGIN & MIDDLEWARE ---
const verifyAdmin = async (req, res, next) => {
  const cookieToken = req.cookies?.adminToken;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader;
  const token = cookieToken || (headerToken && headerToken !== 'null' && headerToken !== 'undefined' ? headerToken : null);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized access. No token provided.' });
  }
  try {
    const decoded = jwt.verify(token, ADMIN_TOKEN_SECRET);
    req.admin = decoded;
    
    // Audit Log for Mutations
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      try {
        await db.collection('admin_audit_logs').add({
          action: `${req.method} ${req.originalUrl}`,
          ip: req.ip,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          adminEmail: req.admin.email
        });
      } catch (err) {
        console.error('Audit Log Error:', err);
      }
    }
    
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized access. Invalid or expired token.' });
  }
};

const adminLoginLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per IP
  message: { error: 'Too many login attempts from this IP, please try again after an hour' }
});

// Customer Token & Auth Setup (JWT)
const CUSTOMER_TOKEN_SECRET = process.env.CUSTOMER_TOKEN_SECRET || process.env.ADMIN_TOKEN_SECRET || 'ff_customer_token_secret_key_2026';

function generateCustomerToken(customer) {
  return jwt.sign(
    { id: customer.id || customer._id, email: (customer.email || '').toLowerCase().trim() },
    CUSTOMER_TOKEN_SECRET,
    { expiresIn: '30d' }
  );
}

const verifyCustomer = (req, res, next) => {
  const cookieToken = req.cookies?.customerToken;
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader;
  const token = cookieToken || (headerToken && headerToken !== 'null' && headerToken !== 'undefined' ? headerToken : null);

  // If Admin is authenticated, allow access to customer resource
  const adminCookie = req.cookies?.adminToken;
  if (adminCookie || (authHeader && authHeader.includes('Bearer '))) {
    try {
      const decodedAdmin = jwt.verify(token || adminCookie, ADMIN_TOKEN_SECRET);
      if (decodedAdmin) {
        req.isAdmin = true;
        return next();
      }
    } catch {}
  }

  if (!token) {
    return res.status(401).json({ error: 'Please log in to perform this action.' });
  }

  try {
    const decoded = jwt.verify(token, CUSTOMER_TOKEN_SECRET);
    req.customer = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
};

// Strict Rate Limiters for OTP Endpoints
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 5, // max 5 OTP requests per 15 mins per IP
  message: { error: 'Too many OTP requests. Please wait 15 minutes before requesting again.' }
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 10, // max 10 verify attempts to prevent brute force
  message: { error: 'Too many incorrect attempts. Please request a new OTP.' }
});

// --- ADMIN LOGIN (Email + Password) ---
const ADMIN_CREDENTIALS = [
  { email: (process.env.ADMIN_EMAIL || 'admin@farmersfarm.in').toLowerCase(), pass: process.env.ADMIN_PASS },
  { email: (process.env.ADMIN_EMAIL_2 || '').toLowerCase(), pass: process.env.ADMIN_PASS_2 },
];

router.post('/admin/login', adminLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const inputEmail = (email || '').trim().toLowerCase();
  const inputPass = (password || '').trim();

  const match = ADMIN_CREDENTIALS.find(c => c.email && c.email === inputEmail && c.pass && c.pass === inputPass);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DEV ONLY] Login Attempt for email: '${inputEmail}'`);
  }

  if (match) {
    // Direct JWT login — no OTP step
    const token = jwt.sign({ email: inputEmail, role: 'admin' }, ADMIN_TOKEN_SECRET, { expiresIn: '12h' });

    res.cookie('adminToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    });

    console.log(`✅ Admin login successful: ${inputEmail}`);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Access denied. Invalid email or password.' });
  }
});

router.post('/admin/logout', (req, res) => {
  res.clearCookie('adminToken');
  res.json({ success: true });
});

// --- PRODUCTS ---
router.get('/products', async (req, res) => {
  try {
    const snapshot = await db.collection('products').get();
    const products = [];
    snapshot.forEach(doc => {
      products.push({ id: doc.id, ...doc.data() });
    });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/products', verifyAdmin, upload.single('image'), async (req, res) => {
  const { name, weight, price, note, popular } = req.body;
  let image = '/images/pouch.png';

  if (req.file) {
    try {
      image = await uploadImageAsset(req.file, 'farmers-farm', 'images/uploads');
    } catch (uploadErr) {
      console.error('Product image upload error:', uploadErr);
    }
  }

  const newProduct = {
    name,
    weight,
    price: Number(price),
    note,
    popular: popular === 'true',
    image
  };

  try {
    const docRef = await db.collection('products').add(newProduct);
    res.status(201).json({ success: true, product: { id: docRef.id, ...newProduct } });
  } catch (error) {
    console.error('Firestore Product Save Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/products/:id', verifyAdmin, upload.single('image'), async (req, res) => {
  const { name, weight, price, note, popular } = req.body;
  const updateData = {
    name,
    weight,
    price: Number(price),
    note,
    popular: popular === 'true'
  };

  if (req.file) {
    try {
      updateData.image = await uploadImageAsset(req.file, 'farmers-farm', 'images/uploads');
    } catch (uploadErr) {
      console.error('Product image update error:', uploadErr);
    }
  }

  try {
    const id = req.params.id;
    await db.collection('products').doc(id).update(updateData);
    res.json({ success: true, product: { id, ...updateData } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
router.delete('/products/:id', verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await db.collection('products').doc(id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PROMO CODES ---
router.get('/admin/promos', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('promos').get();
    const promos = [];
    snapshot.forEach(doc => {
      promos.push({ id: doc.id, ...doc.data() });
    });
    res.json(promos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin/promos', verifyAdmin, async (req, res) => {
  const { code, discountPercentage, active } = req.body;
  if (!code || !discountPercentage) {
    return res.status(400).json({ error: 'Code and discount percentage are required' });
  }
  
  try {
    const promoCode = code.toUpperCase().trim();
    await db.collection('promos').doc(promoCode).set({
      code: promoCode,
      discountPercentage: Number(discountPercentage),
      active: active !== false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/promos/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('promos').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/promos/validate', async (req, res) => {
  const { code, total } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });
  
  try {
    const promoCode = code.toUpperCase().trim();
    const doc = await db.collection('promos').doc(promoCode).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Invalid Promo Code' });
    }
    
    const data = doc.data();
    if (!data.active) {
      return res.status(400).json({ error: 'Promo Code is no longer active' });
    }
    
    const discountAmount = (total * data.discountPercentage) / 100;
    const finalTotal = total - discountAmount;
    
    res.json({ 
      success: true, 
      promoCode: data.code,
      discountPercentage: data.discountPercentage,
      discountAmount,
      finalTotal 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ABANDONED CART RECOVERY ---
router.post('/cart/sync', async (req, res) => {
  const { email, name, items, total } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    if (!items || items.length === 0) {
      // If cart is emptied, remove the tracking
      await db.collection('abandoned_carts').doc(email).delete();
    } else {
      // Update cart state
      await db.collection('abandoned_carts').doc(email).set({
        email,
        name,
        items,
        total,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        recoveryEmailSent: false
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ORDERS ---
router.get('/orders', verifyAdmin, async (req, res) => {
  try {
    // Return newest orders first
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = [];
    snapshot.forEach(doc => {
      orders.push({ id: doc.id, ...doc.data() });
    });
    res.json(orders);
  } catch (error) {
    try {
      const snapshot = await db.collection('orders').get();
      const orders = [];
      snapshot.forEach(doc => {
        orders.push({ id: doc.id, ...doc.data() });
      });
      res.json(orders);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.post('/orders', async (req, res) => {
  try {
    const { items, customer, shipping, paymentMethod, paymentId, total, promoCode } = req.body;
    
    // 1. Validation
    if (!customer || !customer.email || !customer.name) {
      return res.status(400).json({ error: 'Customer name and email are required.' });
    }
    if (!shipping || !shipping.address) {
      return res.status(400).json({ error: 'Shipping address is required.' });
    }

    // 2. Prevent Negative Quantity Exploit
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order must contain at least one item.' });
    }

    for (const item of items) {
      const qty = parseInt(item.qty || item.quantity, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 100) {
        return res.status(400).json({ error: `Invalid quantity for ${item.name || 'product'}. Must be between 1 and 100.` });
      }
      const price = parseFloat(item.price);
      if (isNaN(price) || price < 0) {
        return res.status(400).json({ error: `Invalid price for ${item.name || 'product'}.` });
      }
    }

    // 3. Server-side Subtotal & Discount Recalculation (Price Manipulation Protection)
    const calculatedSubtotal = items.reduce((sum, item) => sum + (parseFloat(item.price) * parseInt(item.qty, 10)), 0);
    
    let calculatedDiscount = 0;
    if (promoCode) {
      try {
        const promoDoc = await db.collection('promos').doc(promoCode.toUpperCase().trim()).get();
        if (promoDoc.exists && promoDoc.data().active) {
          calculatedDiscount = Math.round((calculatedSubtotal * promoDoc.data().discountPercentage) / 100);
        }
      } catch (err) {
        console.warn('Promo check error:', err);
      }
    }

    const expectedTotal = Math.max(0, calculatedSubtotal - calculatedDiscount);

    // Verify client total matches within rounding threshold
    const clientTotal = parseFloat(total);
    if (!isNaN(clientTotal) && Math.abs(clientTotal - expectedTotal) > 5) {
      return res.status(400).json({ 
        error: `Price verification failed. Expected: ₹${expectedTotal}, received: ₹${clientTotal}.` 
      });
    }

    // 4. Secure Order ID & Mass Assignment Sanitization
    const crypto = require('crypto');
    const orderId = req.body.id && /^ORD-[A-Za-z0-9]{4,10}$/.test(req.body.id) 
      ? req.body.id 
      : 'ORD-' + crypto.randomInt(10000, 99999);

    const sanitizedOrder = {
      id: orderId,
      date: new Date().toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }),
      items: items.map(i => ({
        id: String(i.id || ''),
        name: String(i.name || ''),
        weight: String(i.weight || i.size || ''),
        price: parseFloat(i.price),
        qty: parseInt(i.qty, 10)
      })),
      subtotal: calculatedSubtotal,
      discount: calculatedDiscount,
      total: expectedTotal,
      paymentMethod: String(paymentMethod || 'Cash on Delivery'),
      paymentId: paymentId ? String(paymentId) : null,
      status: 'Pending',
      customer: {
        name: String(customer.name).slice(0, 100),
        email: String(customer.email).toLowerCase().trim().slice(0, 100),
        phone: String(customer.phone || '').slice(0, 20)
      },
      shipping: {
        address: String(shipping.address).slice(0, 300),
        city: String(shipping.city || '').slice(0, 100),
        pin: String(shipping.pin || '').slice(0, 10)
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Save order
    await db.collection('orders').doc(orderId).set(sanitizedOrder);

    // Clear abandoned cart if it exists
    if (sanitizedOrder.customer?.email) {
      await db.collection('abandoned_carts').doc(sanitizedOrder.customer.email).delete().catch(() => {});
    }

    // Send Order Confirmation Email
    const email = sanitizedOrder.customer?.email;
    const subject = `Order Confirmed - Farmers Farm (#${sanitizedOrder.id})`;
    const message = `Hi ${sanitizedOrder.customer.name},\n\nYour order #${sanitizedOrder.id} for Farmers Farm has been confirmed! 🌿\n\nTotal: ₹${sanitizedOrder.total.toLocaleString('en-IN')}\nPayment: ${sanitizedOrder.paymentMethod}\n\nWe will notify you once it's shipped. Thank you!`;
    sendOrderEmail(email, subject, message);

    res.json({ success: true, order: sanitizedOrder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/orders/:id/status', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    // Find the order by its custom ID (ORD-XXXX)
    const snapshot = await db.collection('orders').where('id', '==', id).get();
    let docRef;
    let orderData;

    if (!snapshot.empty) {
      docRef = snapshot.docs[0].ref;
      orderData = snapshot.docs[0].data();
    } else {
      // Fallback: Check if it exists by document ID
      const doc = await db.collection('orders').doc(id).get();
      if (!doc.exists) {
        return res.status(404).json({ error: 'Order not found' });
      }
      docRef = doc.ref;
      orderData = doc.data();
    }

    await docRef.update({ status });
    
    // Send Email notification
    const email = orderData.customer?.email;
    const subject = `Order Update - Farmers Farm (#${id})`;
    let message = `Update on your Farmers Farm order #${id}: \n\nYour order is now ${status}.`;
    if (status === 'Shipped') {
      message += ` 🚚 It is on its way to you!`;
    } else if (status === 'Delivered') {
      message += ` ✅ It has been delivered. Enjoy your tea! 🍵`;
    }
    sendOrderEmail(email, subject, message);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders/customer/:email', verifyCustomer, async (req, res) => {
  const email = (req.params.email || '').toLowerCase().trim();
  if (!req.isAdmin && req.customer?.email !== email) {
    return res.status(403).json({ error: 'Forbidden: You cannot access another customer\'s orders.' });
  }
  try {
    const snapshot = await db.collection('orders').where('customer.email', '==', email).get();
    const orders = [];
    snapshot.forEach(doc => {
      orders.push({ id: doc.id, ...doc.data() });
    });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/review', async (req, res) => {
  const { id } = req.params;
  const { rating, comment } = req.body;
  try {
    await db.collection('orders').doc(id).update({
      review: { rating, comment, date: new Date().toLocaleString('en-IN') }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/orders/:id/complaint', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  try {
    await db.collection('orders').doc(id).update({
      complaint: { text, date: new Date().toLocaleString('en-IN') }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- PRODUCT REVIEWS (PHOTO REVIEWS) ---
router.post('/products/:id/reviews', reviewUpload.single('photo'), async (req, res) => {
  const { id } = req.params; // Product ID
  const { rating, comment, name } = req.body;
  
  try {
    const reviewData = {
      productId: id,
      name: name || 'Anonymous',
      rating: parseInt(rating) || 5,
      comment: comment || '',
      date: new Date().toLocaleString('en-IN'),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (req.file) {
      try {
        reviewData.photoUrl = await uploadImageAsset(req.file, 'farmers-farm/reviews', 'uploads/reviews');
      } catch (uploadErr) {
        console.error('Review Upload Error:', uploadErr);
        return res.status(500).json({ error: 'Image upload failed.' });
      }
    }

    const docRef = await db.collection('product_reviews').add(reviewData);
    res.json({ success: true, review: { id: docRef.id, ...reviewData } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/products/:id/reviews', async (req, res) => {
  const { id } = req.params;
  try {
    const snapshot = await db.collection('product_reviews')
      .where('productId', '==', id)
      .orderBy('createdAt', 'desc')
      .get();
      
    const reviews = [];
    snapshot.forEach(doc => {
      reviews.push({ id: doc.id, ...doc.data() });
    });
    res.json(reviews);
  } catch (error) {
    // If index is missing, fallback without orderBy
    try {
       const snapshot = await db.collection('product_reviews').where('productId', '==', id).get();
       const reviews = [];
       snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
       res.json(reviews.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    } catch(err) {
       res.status(500).json({ error: err.message });
    }
  }
});

router.get('/admin/reviews', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('product_reviews').orderBy('createdAt', 'desc').get();
    const reviews = [];
    snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
    res.json(reviews);
  } catch (error) {
    try {
      const snapshot = await db.collection('product_reviews').get();
      const reviews = [];
      snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
      res.json(reviews);
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.get('/reviews', async (req, res) => {
  try {
    const snapshot = await db.collection('product_reviews').orderBy('createdAt', 'desc').limit(20).get();
    const reviews = [];
    snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
    res.json(reviews);
  } catch (error) {
    try {
      const snapshot = await db.collection('product_reviews').get();
      const reviews = [];
      snapshot.forEach(doc => reviews.push({ id: doc.id, ...doc.data() }));
      res.json(reviews.slice(0, 20));
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.delete('/admin/reviews/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('product_reviews').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- BLOGS & SEO ---
router.get('/blogs', async (req, res) => {
  try {
    const snapshot = await db.collection('blogs').orderBy('createdAt', 'desc').get();
    const blogs = [];
    snapshot.forEach(doc => blogs.push({ id: doc.id, ...doc.data() }));
    res.json(blogs);
  } catch (error) {
    try {
      const snapshot = await db.collection('blogs').get();
      const blogs = [];
      snapshot.forEach(doc => blogs.push({ id: doc.id, ...doc.data() }));
      res.json(blogs);
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.get('/blogs/:slug', async (req, res) => {
  try {
    const snapshot = await db.collection('blogs').where('slug', '==', req.params.slug).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Blog not found' });
    res.json({ id: snapshot.docs[0].id, ...snapshot.docs[0].data() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/admin/blogs', verifyAdmin, async (req, res) => {
  try {
    const { title, slug, content, excerpt, metaDescription, keywords, imageUrl } = req.body;
    const blogData = {
      title,
      slug,
      content,
      excerpt,
      metaDescription,
      keywords,
      imageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('blogs').add(blogData);
    res.json({ success: true, blog: { id: docRef.id, ...blogData } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/admin/blogs/:id', verifyAdmin, async (req, res) => {
  try {
    await db.collection('blogs').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- CUSTOMERS ---
router.get('/customers', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('customers').get();
    const customers = [];
    snapshot.forEach(doc => {
      customers.push(sanitizeCustomer({ id: doc.id, ...doc.data() }));
    });
    res.json(customers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/customers', async (req, res) => {
  const { name, phone, password, ...rest } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  try {
    // Check if customer exists
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (!snapshot.empty) {
      return res.status(400).json({ error: 'Customer with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const customer = {
      ...rest,
      name: name.trim(),
      email,
      phone: (phone || '').trim(),
      password: hashedPassword,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('customers').add(customer);
    const custData = sanitizeCustomer({ id: docRef.id, ...customer }); res.json({ success: true, customer: custData, token: generateCustomerToken(custData) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- CUSTOMER AUTH: EMAIL + PASSWORD ---
router.post('/customers/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (snapshot.empty) {
      return res.status(401).json({ error: 'No account found with this email' });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    if (!data.password) {
      return res.status(401).json({ error: 'This account uses Google or OTP login. Please sign in with OTP or Google.' });
    }

    let valid = false;
    if (data.password.startsWith('$2a$') || data.password.startsWith('$2b$') || data.password.startsWith('$2y$')) {
      valid = await bcrypt.compare(password, data.password);
    } else {
      valid = (data.password === password);
    }

    if (!valid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const custData = sanitizeCustomer({ id: doc.id, ...data }); res.json({ success: true, customer: custData, token: generateCustomerToken(custData) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- CUSTOMER AUTH: OTP ---
router.post('/customers/request-otp', otpRequestLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStorage.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
  console.log(`🔑 [CUSTOMER OTP] Generated for '${email}'`);

  try {
    const via = await sendEmail({
      to: email,
      subject: `${otp} is your Farmers Farm verification code`,
      text: `Your Farmers Farm OTP is ${otp}. Valid for 10 minutes.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0C160F; color: #FAF6ED; border-radius: 12px; border: 1px solid rgba(212,160,23,0.3); text-align: center;">
          <h2 style="color: #D4A017; font-size: 24px; margin: 0 0 8px; letter-spacing: 1.5px; text-transform: uppercase;">Farmers Farm</h2>
          <p style="font-size: 13px; color: #A3B899; margin: 0 0 24px; text-transform: uppercase; letter-spacing: 1px;">Est. 2020 · Pure Harvest</p>
          <div style="border-top: 1px solid rgba(212,160,23,0.2); margin-bottom: 24px;"></div>
          <p style="font-size: 15px; color: #E2DACB; line-height: 1.5; margin: 0 0 20px;">Use the verification code below to securely sign in to your Farmers Farm account:</p>
          <div style="background: rgba(212,160,23,0.08); border: 2px dashed rgba(212,160,23,0.5); border-radius: 10px; padding: 18px 20px; display: inline-block; min-width: 220px; margin-bottom: 24px;">
            <span style="font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #F0C040; font-family: monospace;">${otp}</span>
          </div>
          <p style="font-size: 13px; color: #A3B899; margin: 0 0 16px;">This OTP is valid for <strong>10 minutes</strong>. Never share this code with anyone.</p>
          <div style="border-top: 1px solid rgba(212,160,23,0.2); margin: 24px 0 16px;"></div>
          <p style="font-size: 11px; color: #7A8D74; margin: 0;">Farm to Cup · 100% Natural Organic Tea · If you didn't request this, please ignore.</p>
        </div>
      `
    });
    console.log(`✅ OTP email sent to '${email}' via ${via}`);
    // Security: Do NOT return the OTP in the API response
    res.json({ success: true, message: 'OTP sent to your email successfully' });
  } catch (error) {
    console.error('Error in request OTP:', error?.message || error);
    const errMsg = String(error?.message || '').toLowerCase();
    const isTimeoutOrBlocked = error?.code === 'ETIMEDOUT' || error?.code === 'ECONNECTION' || errMsg.includes('timeout') || errMsg.includes('greeting never received');
    if (isTimeoutOrBlocked) {
      return res.status(503).json({
        error: 'Email delivery timed out (free hosting blocks Gmail SMTP). Please use Password Login or configure BREVO_API_KEY / EMAIL_WEBHOOK_URL.'
      });
    }
    res.status(500).json({ error: 'Failed to send OTP email. Please check your email or use Password login.' });
  }
});

router.post('/customers/verify-otp', otpVerifyLimiter, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }
  const cleanEmail = email.toLowerCase().trim();
  const storedData = otpStorage.get(cleanEmail);

  if (!storedData || Date.now() > storedData.expiresAt || storedData.otp !== otp.toString().trim()) {
    return res.status(401).json({ error: 'Invalid or expired OTP' });
  }

  otpStorage.delete(cleanEmail);

  try {
    let customerData;
    const snapshot = await db.collection('customers').where('email', '==', cleanEmail).get();
    
    if (snapshot.empty) {
      // Create new customer if they don't exist
      const newCustomer = { email: cleanEmail, name: cleanEmail.split('@')[0], createdAt: admin.firestore.FieldValue.serverTimestamp() };
      const docRef = await db.collection('customers').add(newCustomer);
      customerData = { id: docRef.id, ...newCustomer };
    } else {
      snapshot.forEach(doc => { customerData = { id: doc.id, ...doc.data() }; });
    }
    const custData = sanitizeCustomer(customerData); res.json({ success: true, customer: custData, token: generateCustomerToken(custData) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- CUSTOMER AUTH: GOOGLE LOGIN ---
router.post('/customers/google-login', async (req, res) => {
  const { credential } = req.body;
  const clientId = getGoogleClientId();

  if (!clientId) {
    return res.status(503).json({
      error: 'Google Login is not configured on the server yet. Please add GOOGLE_CLIENT_ID in backend/.env.'
    });
  }
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential token.' });
  }

  try {
    const googleClient = new OAuth2Client(clientId);
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId
    });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.name || email.split('@')[0];
    const picture = payload.picture || '';

    let customerData;
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (snapshot.empty) {
      const newCustomer = {
        email,
        name,
        picture,
        authProvider: 'google',
        emailVerified: payload.email_verified === true,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      const docRef = await db.collection('customers').add(newCustomer);
      customerData = { id: docRef.id, ...newCustomer };
    } else {
      const doc = snapshot.docs[0];
      const existing = doc.data();
      const updates = { authProvider: existing.authProvider || 'google' };
      if (picture && existing.picture !== picture) updates.picture = picture;
      if (name && !existing.name) updates.name = name;
      await doc.ref.update(updates).catch(() => {});
      customerData = { id: doc.id, ...existing, ...updates };
    }
    const custData = sanitizeCustomer(customerData); res.json({ success: true, customer: custData, token: generateCustomerToken(custData) });
  } catch (error) {
    console.error('Google Auth Error:', error.message || error);
    res.status(401).json({ error: 'Google authentication failed. Please verify GOOGLE_CLIENT_ID and authorized origins.' });
  }
});

// --- CUSTOMER PROFILE & WISHLIST ---
router.post('/customers/:email/wishlist', verifyCustomer, async (req, res) => {
  const { wishlist } = req.body;
  const email = req.params.email.toLowerCase();
  if (!req.isAdmin && req.customer?.email !== email) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  try {
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Customer not found' });
    
    const customerId = snapshot.docs[0].id;
    await db.collection('customers').doc(customerId).update({ wishlist: wishlist || [] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customers/:email/wishlist', verifyCustomer, async (req, res) => {
  const email = req.params.email.toLowerCase();
  if (!req.isAdmin && req.customer?.email !== email) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  try {
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Customer not found' });
    
    const customerData = snapshot.docs[0].data();
    res.json(customerData.wishlist || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/customers/:email', verifyCustomer, async (req, res) => {
  const email = req.params.email.toLowerCase().trim();
  if (!req.isAdmin && req.customer?.email !== email) {
    return res.status(403).json({ error: 'Forbidden: Cannot edit another customer\'s profile.' });
  }

  // Mass Assignment Protection - Explicit Allowlist
  const { name, phone, address, city, pin } = req.body;
  const sanitizedUpdate = {};
  if (name !== undefined) sanitizedUpdate.name = String(name).slice(0, 100);
  if (phone !== undefined) sanitizedUpdate.phone = String(phone).slice(0, 20);
  if (address !== undefined) sanitizedUpdate.address = String(address).slice(0, 300);
  if (city !== undefined) sanitizedUpdate.city = String(city).slice(0, 100);
  if (pin !== undefined) sanitizedUpdate.pin = String(pin).slice(0, 10);

  try {
    const snapshot = await db.collection('customers').where('email', '==', email).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Customer not found' });
    
    const customerId = snapshot.docs[0].id;
    await db.collection('customers').doc(customerId).update(sanitizedUpdate);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FEEDBACKS ---
router.get('/feedbacks', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('feedbacks').orderBy('createdAt', 'desc').get();
    const feedbacks = [];
    snapshot.forEach(doc => {
      feedbacks.push({ id: doc.id, ...doc.data() });
    });
    res.json(feedbacks);
  } catch (error) {
    try {
      const snapshot = await db.collection('feedbacks').get();
      const feedbacks = [];
      snapshot.forEach(doc => {
        feedbacks.push({ id: doc.id, ...doc.data() });
      });
      res.json(feedbacks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

router.post('/feedbacks', async (req, res) => {
  const feedback = req.body;
  feedback.createdAt = admin.firestore.FieldValue.serverTimestamp();
  try {
    await db.collection('feedbacks').add(feedback);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- RAZORPAY PAYMENTS ---
router.post('/payment/create', async (req, res) => {
  const { amount } = req.body;

  // If no Razorpay keys, return COD mock
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return res.json({
      id: 'cod_' + Date.now(),
      amount: amount * 100,
      currency: 'INR',
      cod: true
    });
  }

  try {
    const options = {
      amount: Math.round(amount * 100), // Amount in paise
      currency: 'INR',
      receipt: 'receipt_' + Date.now(),
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Razorpay Order Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment/verify', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  // If no keys configured, just pass through
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.json({ success: true });
  }

  try {
    const crypto = require('crypto');
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- RAZORPAY PAYMENT ENDPOINTS ---
router.post('/create-razorpay-order', async (req, res) => {
  try {
    const { amount, receipt } = req.body;
    const hasKeys = process.env.RAZORPAY_KEY_ID && 
                    process.env.RAZORPAY_KEY_SECRET && 
                    process.env.RAZORPAY_KEY_ID !== 'dummy' &&
                    process.env.RAZORPAY_KEY_SECRET !== 'dummy';

    if (!hasKeys) {
      console.log(`[DEMO MODE] Generating mock Razorpay order for ₹${amount}`);
      return res.json({
        id: 'order_demo_' + Date.now().toString(36),
        amount: Math.round(amount * 100),
        currency: 'INR',
        receipt: receipt || `rcpt_${Date.now()}`,
        status: 'created',
        demoMode: true
      });
    }

    const options = {
      amount: Math.round(amount * 100), // amount in paise
      currency: "INR",
      receipt: receipt || `rcpt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Error creating Razorpay order:', error);
    res.status(500).json({ error: 'Could not create payment order.' });
  }
});

router.get('/razorpay-key', (req, res) => {
  const hasKey = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_ID !== 'dummy';
  res.json({ key: hasKey ? process.env.RAZORPAY_KEY_ID : 'rzp_demo_key' });
});

router.post('/verify-payment', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const secret = process.env.RAZORPAY_KEY_SECRET;

    // Demo Mode acceptance
    if (!secret || secret === 'dummy' || (razorpay_order_id && razorpay_order_id.startsWith('order_demo_'))) {
      console.log(`[DEMO MODE] Verified demo payment for ${razorpay_order_id}`);
      return res.json({ success: true, message: 'Payment verified successfully (Demo Mode).' });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      res.json({ success: true, message: 'Payment verified successfully.' });
    } else {
      res.status(400).json({ success: false, error: 'Invalid signature.' });
    }
  } catch (error) {
    console.error('Error verifying Razorpay payment:', error);
    res.status(500).json({ error: 'Payment verification failed.' });
  }
});

// --- ABANDONED CART BACKGROUND JOB ---
// Runs every 30 minutes to check for abandoned carts older than 2 hours
async function processAbandonedCarts() {
  console.log('[CRON] Checking for abandoned carts...');
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const snapshot = await db.collection('abandoned_carts')
      .where('recoveryEmailSent', '==', false)
      .get();
      
    if (snapshot.empty) return;
    
    for (const doc of snapshot.docs) {
      try {
        const cart = doc.data();
        // Check if lastUpdated is older than 2 hours
        const lastUpdatedDate = cart.lastUpdated?.toDate ? cart.lastUpdated.toDate() : new Date();
        if (lastUpdatedDate < twoHoursAgo) {
          const email = cart.email;
          const name = cart.name || 'Tea Lover';
          const subject = `Did you forget something, ${name}? 🌿`;
          
          let itemsHtml = cart.items.map(i => `<li>${i.name} (${i.size || i.weight}) x${i.qty}</li>`).join('');
          
          const message = `
            Hi ${name},<br><br>
            We noticed you left some delicious tea in your cart at Farmers Farm.<br>
            We've saved your selections so you can easily complete your purchase whenever you're ready.<br><br>
            <b>Your Cart:</b><br>
            <ul>${itemsHtml}</ul><br>
            <b>Total:</b> ₹${cart.total.toLocaleString('en-IN')}<br><br>
            <a href="${process.env.APP_URL || 'https://farmersfarm.in'}/cart.html" style="background:#d4af37; color:#111; padding:10px 20px; text-decoration:none; font-weight:bold; border-radius:4px;">Complete Purchase</a><br><br>
            Warmly,<br>
            Farmers Farm Team
          `;
          
          await sendOrderEmail(email, subject, message);
          await doc.ref.update({ recoveryEmailSent: true });
        }
      } catch (innerErr) {
        console.error(`Error processing abandoned cart for doc ${doc.id}:`, innerErr);
      }
    }
  } catch (err) {
    console.error('Error running abandoned cart job:', err);
  }
}

// Run every 30 minutes (unref so it doesn't block graceful shutdown)
setInterval(processAbandonedCarts, 30 * 60 * 1000).unref();

// Manual trigger for Admin
router.post('/admin/trigger-abandoned-carts', verifyAdmin, async (req, res) => {
  try {
    await processAbandonedCarts();
    res.json({ success: true, message: 'Abandoned cart job triggered.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- NEWSLETTER SUBSCRIPTION ---
router.post('/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  try {
    const snapshot = await db.collection('subscribers').where('email', '==', email.toLowerCase()).get();
    if (!snapshot.empty) {
      return res.json({ success: true, message: 'Already subscribed' });
    }
    await db.collection('subscribers').add({
      email: email.toLowerCase(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/subscribers', verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('subscribers').orderBy('createdAt', 'desc').get();
    const subs = [];
    snapshot.forEach(doc => subs.push({ id: doc.id, ...doc.data() }));
    res.json(subs);
  } catch (err) {
    try {
      const snapshot = await db.collection('subscribers').get();
      const subs = [];
      snapshot.forEach(doc => subs.push({ id: doc.id, ...doc.data() }));
      res.json(subs);
    } catch (fallbackErr) {
      res.status(500).json({ error: fallbackErr.message });
    }
  }
});

module.exports = router;
