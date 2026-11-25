/* ═══════════════════════════════════════════════════════
   FARMERS FARM – 3D EFFECTS ENGINE  (Presentation Edition)
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  /* ── 1. SCROLL PROGRESS BAR ── */
  const scrollBar = document.getElementById('scrollProgress');
  if (scrollBar) {
    window.addEventListener('scroll', () => {
      const pct = window.scrollY / (document.body.scrollHeight - window.innerHeight) * 100;
      scrollBar.style.width = Math.min(100, pct) + '%';
    }, { passive: true });
  }

  /* ── 2. CUSTOM CURSOR GLOW ── */
  const cursorGlow = document.getElementById('cursorGlow');
  if (cursorGlow) {
    let mx = 0, my = 0, cx = 0, cy = 0;
    document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });
    function animCursor() {
      cx += (mx - cx) * 0.12;
      cy += (my - cy) * 0.12;
      cursorGlow.style.left = cx + 'px';
      cursorGlow.style.top  = cy + 'px';
      requestAnimationFrame(animCursor);
    }
    animCursor();
    // Hide on mobile
    if ('ontouchstart' in window) cursorGlow.style.display = 'none';
  }

  /* ── 3. HERO PARTICLE CANVAS ── */
  const canvas = document.getElementById('heroCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let W, H, particles = [];

    function resize() {
      W = canvas.width  = canvas.offsetWidth;
      H = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    class Particle {
      constructor() { this.reset(); }
      reset() {
        this.x    = Math.random() * W;
        this.y    = H + 10;
        this.r    = Math.random() * 2.5 + 0.5;
        this.vx   = (Math.random() - 0.5) * 0.6;
        this.vy   = -(Math.random() * 1.2 + 0.4);
        this.alpha = 0;
        this.maxAlpha = Math.random() * 0.5 + 0.2;
        this.color = Math.random() > 0.5
          ? `rgba(212,160,23,${this.maxAlpha})`
          : `rgba(90,148,112,${this.maxAlpha})`;
        this.phase = Math.random() * Math.PI * 2;
      }
      update() {
        this.x  += this.vx + Math.sin(this.phase + performance.now()/3000) * 0.3;
        this.y  += this.vy;
        this.alpha = Math.min(this.maxAlpha, this.alpha + 0.01);
        if (this.y < -10) this.reset();
      }
      draw() {
        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.fillStyle = this.color;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // Create particles
    for (let i = 0; i < 60; i++) {
      const p = new Particle();
      p.y = Math.random() * H; // scatter initially
      particles.push(p);
    }

    function animParticles() {
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => { p.update(); p.draw(); });
      requestAnimationFrame(animParticles);
    }
    animParticles();
  }

  /* ── 4. HERO MOUSE PARALLAX ── */
  const hero = document.querySelector('.hero');
  const heroInner = document.querySelector('.hero-inner');
  if (hero && heroInner) {
    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      const cx = rect.width  / 2;
      const cy = rect.height / 2;
      const dx = (e.clientX - rect.left - cx) / cx;
      const dy = (e.clientY - rect.top  - cy) / cy;
      heroInner.style.transform =
        `perspective(1000px) rotateX(${-dy * 4}deg) rotateY(${dx * 4}deg) translateZ(10px)`;
    }, { passive: true });
    hero.addEventListener('mouseleave', () => {
      heroInner.style.transform = '';
      heroInner.style.transition = 'transform 0.8s cubic-bezier(0.25,0.46,0.45,0.94)';
      setTimeout(() => heroInner.style.transition = '', 800);
    }, { passive: true });
  }

  /* ── 5. ABOUT SECTION PARALLAX SCROLL ── */
  const aboutVisual = document.querySelector('.about-visual');
  if (aboutVisual) {
    window.addEventListener('scroll', () => {
      const rect = aboutVisual.getBoundingClientRect();
      const viewH = window.innerHeight;
      if (rect.top < viewH && rect.bottom > 0) {
        const prog = (viewH - rect.top) / (viewH + rect.height);
        const offset = (prog - 0.5) * 30;
        aboutVisual.style.transform = `translateY(${offset}px)`;
      }
    }, { passive: true });
  }

  /* ── 6. VANILLA-TILT RE-INIT ON DYNAMIC CARDS ── */
  // VanillaTilt is already initialized for static cards via inline script.
  // We enhance tilt config here for more drama.
  function reinitTilt(selector, opts) {
    if (typeof VanillaTilt === 'undefined') return;
    const els = document.querySelectorAll(selector);
    els.forEach(el => {
      if (el._vanillaTilt) el._vanillaTilt.destroy();
    });
    if (els.length) VanillaTilt.init(els, opts);
  }

  // Run after page load so dynamic products are in DOM
  window.addEventListener('load', () => {
    reinitTilt('.ing-card', {
      max: 20, speed: 300, glare: true, 'max-glare': 0.3,
      scale: 1.05, perspective: 600
    });
    reinitTilt('.packet-card', {
      max: 12, speed: 400, glare: true, 'max-glare': 0.15,
      scale: 1.03, perspective: 800
    });
    reinitTilt('.testimonial-card', {
      max: 8, speed: 400, glare: true, 'max-glare': 0.08,
      scale: 1.02, perspective: 1000
    });
    reinitTilt('.contact-card', {
      max: 10, speed: 400, glare: true, 'max-glare': 0.1,
      scale: 1.03, perspective: 800
    });
  });

  // Also watch for new packet cards added dynamically
  const packetsGrid = document.getElementById('packetsGrid');
  if (packetsGrid && typeof MutationObserver !== 'undefined') {
    const ob = new MutationObserver(() => {
      setTimeout(() => {
        reinitTilt('.packet-card', {
          max: 12, speed: 400, glare: true, 'max-glare': 0.15,
          scale: 1.03, perspective: 800
        });
      }, 100);
    });
    ob.observe(packetsGrid, { childList: true });
  }

  /* ── 7. SCROLL-TRIGGERED COUNTER ANIMATION ── */
  function animateCounters() {
    document.querySelectorAll('.stat-num[data-count]').forEach(el => {
      const target = parseInt(el.dataset.count, 10);
      const suffix = el.dataset.suffix || '';
      const dur = 1800;
      const start = performance.now();
      function step(now) {
        const prog = Math.min((now - start) / dur, 1);
        // ease-out
        const ease = 1 - Math.pow(1 - prog, 3);
        const val = Math.round(ease * target);
        el.textContent = val >= 1000 ? val.toLocaleString('en-IN') + suffix : val + suffix;
        if (prog < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // Trigger counters when about section comes into view
  const aboutSection = document.getElementById('about');
  if (aboutSection && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        animateCounters();
        io.disconnect();
      }
    }, { threshold: 0.4 });
    io.observe(aboutSection);
  }

  /* ── 8. SECTION ENTRANCE – 3D SLIDE-IN via IntersectionObserver ── */
  const reveals = document.querySelectorAll('section');
  if ('IntersectionObserver' in window) {
    const sectionObs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'none';
          sectionObs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    reveals.forEach(s => {
      s.style.transition = 'opacity 0.6s ease, transform 0.6s cubic-bezier(0.25,0.46,0.45,0.94)';
      sectionObs.observe(s);
    });
  }

  /* ── 9. INGREDIENT CARD SPARKLE ON HOVER ── */
  document.querySelectorAll('.ing-card').forEach(card => {
    card.addEventListener('mouseenter', (e) => {
      for (let i = 0; i < 5; i++) {
        const spark = document.createElement('div');
        spark.style.cssText = `
          position:absolute; width:4px; height:4px; border-radius:50%;
          background:var(--gold-bright); pointer-events:none; z-index:999;
          left:${Math.random()*100}%; top:${Math.random()*100}%;
          animation:sparkleFade 0.8s forwards;
        `;
        card.appendChild(spark);
        setTimeout(() => spark.remove(), 800);
      }
    });
  });

  /* ── 10. SHOP SECTION STAGGER ANIMATION ── */
  const shopObs = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) {
      document.querySelectorAll('.packet-card').forEach((c, i) => {
        c.style.opacity = '0';
        c.style.transform = 'translateY(40px) rotateX(15deg)';
        c.style.transition = `opacity 0.5s ${i * 0.1}s ease, transform 0.5s ${i * 0.1}s cubic-bezier(0.25,0.46,0.45,0.94)`;
        setTimeout(() => {
          c.style.opacity = '1';
          c.style.transform = '';
        }, 100 + i * 100);
      });
      shopObs.disconnect();
    }
  }, { threshold: 0.2 });
  const shopSec = document.getElementById('shop');
  if (shopSec) shopObs.observe(shopSec);

  /* ── 11. NAV SCROLL EFFECT ── */
  const nav = document.querySelector('nav');
  if (nav) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 60) {
        nav.style.boxShadow = '0 8px 40px rgba(0,0,0,0.4), 0 1px 0 rgba(255,255,255,0.05) inset';
        nav.style.backdropFilter = 'blur(32px) saturate(200%)';
      } else {
        nav.style.boxShadow = '';
        nav.style.backdropFilter = 'blur(24px) saturate(180%)';
      }
    }, { passive: true });
  }

  /* ── 12. QUICK FIX – Add "data-tilt" to dynamically added packet cards ── */
  // Runs after packetsGrid is populated
  if (packetsGrid) {
    const initTiltOnGrid = () => {
      packetsGrid.querySelectorAll('.packet-card:not([data-tilt-inited])').forEach(card => {
        card.setAttribute('data-tilt-inited', '1');
        if (typeof VanillaTilt !== 'undefined') {
          VanillaTilt.init(card, {
            max: 12, speed: 400, glare: true, 'max-glare': 0.15, scale: 1.03, perspective: 800
          });
        }
      });
    };
    // poll until products loaded (max 5s)
    let tries = 0;
    const poll = setInterval(() => {
      initTiltOnGrid();
      if (++tries > 50) clearInterval(poll);
    }, 100);
  }

})();
