const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { db } = require('./firebase');
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;

// ── Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});

// ── CORS Configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  `http://localhost:${PORT}`, // Dynamically allow whatever port the app runs on
  'https://farmersfarm.in',
  'https://www.farmersfarm.in'
];
if (process.env.RAILWAY_STATIC_URL) allowedOrigins.push(`https://${process.env.RAILWAY_STATIC_URL}`);
if (process.env.RENDER_EXTERNAL_URL) allowedOrigins.push(process.env.RENDER_EXTERNAL_URL);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || 
        allowedOrigins.includes(origin) || 
        origin.endsWith('.onrender.com') ||
        (origin.endsWith('.railway.app') && origin.includes('farmers')) || 
        (process.env.NODE_ENV !== 'production' && (origin.includes('localhost') || origin.includes('127.0.0.1')))) {
      callback(null, true);
    } else {
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  credentials: true
}));

// ── Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

// Route for admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Routes for cart and login pages
app.get('/cart', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cart.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// SSR Route for Blog Posts (SEO)
app.get('/blog/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const snapshot = await db.collection('blogs').where('slug', '==', slug).get();
    if (snapshot.empty) {
      return res.status(404).send('Blog Post Not Found');
    }
    const blog = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
    
    // Read the base blog.html template
    const templatePath = path.join(__dirname, '../public/blog.html');
    if (!fs.existsSync(templatePath)) {
      return res.status(404).send('Template Not Found');
    }
    
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Inject SEO Meta Tags
    html = html.replace('<title>Blog - Farmers Farm</title>', `<title>${blog.title} - Farmers Farm</title>`);
    html = html.replace('<!-- SEO_META_TAGS -->', `
      <meta name="description" content="${blog.metaDescription || blog.excerpt || blog.title}">
      <meta name="keywords" content="${blog.keywords || ''}">
      <meta property="og:title" content="${blog.title}">
      <meta property="og:description" content="${blog.metaDescription || blog.excerpt || blog.title}">
      <meta property="og:image" content="${blog.imageUrl || ''}">
    `);
    
    // Inject the blog content directly to HTML
    html = html.replace('<!-- BLOG_SSR_CONTENT -->', `
      <div class="blog-ssr-container">
        <h1 class="blog-ssr-title">${blog.title}</h1>
        ${blog.imageUrl ? `<img src="${blog.imageUrl}" class="blog-ssr-image" alt="${blog.title}">` : ''}
        <div class="blog-ssr-body">${blog.content}</div>
      </div>
      <script>window.INITIAL_BLOG_DATA = ${JSON.stringify(blog).replace(/</g, '\\u003c')};</script>
    `);
    
    res.send(html);
  } catch (error) {
    console.error('SSR Error:', error);
    res.status(500).send('Server Error');
  }
});

// Blog Listing Page
app.get('/blogs', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/blog.html'));
});

// Catch-all route to serve the frontend
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  if (err.message && err.message.startsWith('Not allowed by CORS')) {
    return res.status(403).json({ error: 'CORS: Origin not allowed.' });
  }
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🌐 CORS allows any origin dynamically`);
});
