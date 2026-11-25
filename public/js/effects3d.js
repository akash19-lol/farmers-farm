/* ═══════════════════════════════════════════════════════
   FARMERS FARM – 3D EFFECTS ENGINE  (Presentation Edition)
   ═══════════════════════════════════════════════════════ */

(function() {
  'use strict';

  /* ── 1. SCROLL PROGRESS BAR ── */
  const scrollBar = document.getElementById('scrollProgress');
  if (scrollBar) {
    window.addEventListener('scroll', () => {
      const denom = document.body.scrollHeight - window.innerHeight;
      const pct = denom > 0 ? (window.scrollY / denom) * 100 : 0;
      scrollBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }, { passive: true });
  }

  /* ── 2. CUSTOM CURSOR GLOW ── */
  const cursorGlow = document.getElementById('cursorGlow');
  if (cursorGlow) {
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      cursorGlow.style.display = 'none';
    } else {
      let mx = -100, my = -100, cx = -100, cy = -100;
      document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });
      function animCursor() {
        cx += (mx - cx) * 0.14;
        cy += (my - cy) * 0.14;
        cursorGlow.style.left = cx + 'px';
        cursorGlow.style.top  = cy + 'px';
        requestAnimationFrame(animCursor);
      }
      animCursor();
    }
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
        this.r    = Math.random() * 2.5 + 0.6;
        this.vx   = (Math.random() - 0.5) * 0.6;
        this.vy   = -(Math.random() * 1.1 + 0.4);
        this.alpha = 0;
        this.maxAlpha = Math.random() * 0.55 + 0.2;
        this.color = Math.random() > 0.45
          ? `rgba(212,160,23,${this.maxAlpha})`
          : `rgba(90,148,112,${this.maxAlpha})`;
        this.phase = Math.random() * Math.PI * 2;
      }
      update() {
        this.x  += this.vx + Math.sin(this.phase + performance.now() / 3000) * 0.3;
        this.y  += this.vy;
        this.alpha = Math.min(this.maxAlpha, this.alpha + 0.01);
        if (this.y < -10) this.reset();
      }
      draw() {
        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.fillStyle = this.color;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    for (let i = 0; i < 65; i++) {
      const p = new Particle();
      p.y = Math.random() * H;
      particles.push(p);
    }

    function animParticles() {
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => { p.update(); p.draw(); });
      requestAnimationFrame(animParticles);
    }
    animParticles();
  }

  /* ── 4. HERO 3D MOUSE PARALLAX ── */
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
        `perspective(1100px) rotateX(${-dy * 5}deg) rotateY(${dx * 5}deg) translateZ(12px)`;
    }, { passive: true });
    hero.addEventListener('mouseleave', () => {
      heroInner.style.transition = 'transform 0.7s cubic-bezier(0.25,0.46,0.45,0.94)';
      heroInner.style.transform = 'perspective(1100px) rotateX(0deg) rotateY(0deg) translateZ(0px)';
      setTimeout(() => { heroInner.style.transition = 'transform 0.15s ease-out'; }, 700);
    }, { passive: true });
  }

  /* ── 5. SINGLE CLEAN VANILLA-TILT MANAGER ── */
  function initTiltElements(selector, opts) {
    if (typeof VanillaTilt === 'undefined') return;
    const els = document.querySelectorAll(selector);
    els.forEach(el => {
      if (el.vanillaTilt) el.vanillaTilt.destroy();
      VanillaTilt.init(el, opts);
    });
  }

  function refreshDynamicTilts() {
    initTiltElements('.packet-card', {
      max: 14, speed: 400, glare: true, 'max-glare': 0.2,
      scale: 1.04, perspective: 850
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTiltElements('.about-visual', {
      max: 12, speed: 450, glare: true, 'max-glare': 0.18,
      scale: 1.02, perspective: 900
    });
    initTiltElements('.ing-card', {
      max: 16, speed: 350, glare: true, 'max-glare': 0.25,
      scale: 1.04, perspective: 700
    });
    initTiltElements('.testimonial-card', {
      max: 10, speed: 400, glare: true, 'max-glare': 0.1,
      scale: 1.02, perspective: 1000
    });
    initTiltElements('.contact-card', {
      max: 12, speed: 400, glare: true, 'max-glare': 0.14,
      scale: 1.03, perspective: 850
    });
    initTiltElements('.auth-modal', {
      max: 5, speed: 500, glare: false,
      perspective: 1200
    });
    refreshDynamicTilts();
  });

  const packetsGrid = document.getElementById('packetsGrid');
  if (packetsGrid && typeof MutationObserver !== 'undefined') {
    const ob = new MutationObserver(() => {
      refreshDynamicTilts();
    });
    ob.observe(packetsGrid, { childList: true });
  }

  /* ── 6. INGREDIENT CARD GOLD SPARKLE ON HOVER ── */
  document.querySelectorAll('.ing-card').forEach(card => {
    card.addEventListener('mouseenter', () => {
      for (let i = 0; i < 6; i++) {
        const spark = document.createElement('div');
        spark.style.cssText = `
          position:absolute; width:5px; height:5px; border-radius:50%;
          background:var(--gold-bright); pointer-events:none; z-index:999;
          left:${Math.random() * 90 + 5}%; top:${Math.random() * 90 + 5}%;
          animation:sparkleFade 0.8s forwards;
        `;
        card.appendChild(spark);
        setTimeout(() => spark.remove(), 800);
      }
    });
  });

})();
