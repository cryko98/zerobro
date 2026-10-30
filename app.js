(() => {
  const RADIUS = 0.17; // fraction of the character's width
  const TRAIL = 14;
  const stage = document.getElementById("stage");
  const canvas = document.getElementById("gl");
  const ring = document.getElementById("ring");
  const fxCanvas = document.getElementById("fx");
  const ctx = fxCanvas.getContext("2d");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false });
  if (!gl) return;

  const vs = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;

  const fs = `
    precision highp float;
    #define TRAIL ${TRAIL}
    uniform sampler2D u_tex;
    uniform vec3 u_trail[TRAIL]; // x, y, strength — [0] is the cursor
    uniform vec3 u_shock;        // x, y, age in seconds (< 0 = none)
    uniform float u_time;
    uniform float u_radius;
    uniform float u_vel;
    uniform float u_glitch;
    varying vec2 v_uv;

    vec3 hueRotate(vec3 c, float a) {
      const vec3 k = vec3(0.57735);
      float ca = cos(a);
      return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
    }
    // the background is near-black; anything brighter is the body
    float bodyMask(vec3 c) {
      float m = max(c.r, max(c.g, c.b));
      return smoothstep(0.085, 0.17, m);
    }
    float hash(float n) { return fract(sin(n) * 43758.5453); }

    void main() {
      float t = u_time;
      vec2 uv = v_uv;
      uv.y += sin(t * 1.2) * 0.003; // idle breathing

      // cursor + trail field: strongest influence wins
      float inC = 0.0;
      vec2 dir = vec2(0.0);
      float dRel = 1.0;
      for (int i = 0; i < TRAIL; i++) {
        vec3 p = u_trail[i];
        if (p.z <= 0.001) continue;
        float r = u_radius * mix(0.3, 1.0, p.z);
        vec2 d = uv - p.xy;
        float dist = length(d);
        float f = (1.0 - smoothstep(r * 0.4, r, dist)) * p.z;
        if (f > inC) { inC = f; dir = d; dRel = dist / r; }
      }
      vec2 ndir = normalize(dir + 1e-5);

      vec2 suv = uv;
      if (inC > 0.01) {
        // liquid ripple
        suv += ndir * sin(dRel * 18.0 - t * 8.0) * 0.008 * inC;
        // magnifying lens
        suv -= dir * 0.12 * inC * (1.0 - dRel);
        // voxelize the material
        float cells = mix(260.0, 64.0, inC);
        suv = (floor(suv * cells) + 0.5) / cells;
      }

      // click shockwave rolling across the whole body
      float band = 0.0;
      if (u_shock.z >= 0.0) {
        vec2 sd = uv - u_shock.xy;
        float x = length(sd) - u_shock.z * 0.9;
        band = exp(-x * x / 0.003) * exp(-u_shock.z * 1.6);
        suv += normalize(sd + 1e-5) * sin(x * 70.0) * 0.035 * band;
      }

      // glitch slices
      float glt = 0.0;
      if (u_glitch > 0.0) {
        float row = floor(uv.y * 34.0);
        float tick = floor(t * 14.0);
        if (hash(row * 13.1 + tick * 7.7) > 0.7) {
          glt = u_glitch;
          suv.x += (hash(row + tick * 3.3) - 0.5) * 0.1 * u_glitch;
        }
      }

      // hologram scan line sweeping down
      float sy = fract(t * 0.2) * 1.6 - 0.3;
      float scan = exp(-pow((uv.y - sy) / 0.01, 2.0));
      float trailScan = smoothstep(0.12, 0.0, sy - uv.y) * step(uv.y, sy);
      suv.x += scan * 0.006 * sin(uv.y * 900.0);

      // chromatic split
      float split = 0.004 * inC + 0.003 * u_vel * inC + 0.012 * glt + 0.014 * band;
      vec2 off = (inC > 0.01 ? ndir : vec2(1.0, 0.0)) * split;
      vec3 col = vec3(
        texture2D(u_tex, suv + off).r,
        texture2D(u_tex, suv).g,
        texture2D(u_tex, suv - off).b
      );
      float alpha = bodyMask(col);

      // electric recolor under the cursor
      vec3 fx = hueRotate(col, sin(t * 2.2 + dRel * 6.0) * 0.9);
      float l = dot(fx, vec3(0.299, 0.587, 0.114));
      fx = mix(vec3(l), fx, 1.8);
      fx *= 1.25 + 0.5 * sin(dRel * 25.0 - t * 10.0);
      fx += vec3(0.25, 0.35, 0.6) * step(0.9, fract(suv.y * 160.0 + t * 3.0)) * inC;
      vec3 outc = mix(col, fx, inC);

      outc = mix(outc, hueRotate(outc, 1.3), band) + vec3(0.55, 0.45, 1.0) * band * 1.3;
      outc += vec3(0.35, 0.1, 0.55) * glt * 0.6;
      outc += vec3(0.35, 0.75, 1.0) * (scan * 1.1 + trailScan * 0.12);

      float hd = length(uv - u_trail[0].xy);
      float rim = smoothstep(0.008, 0.0, abs(hd - u_radius * 0.92)) * u_trail[0].z;
      outc += vec3(0.65, 0.55, 1.0) * rim;

      gl_FragColor = vec4(outc * alpha, alpha);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) {
    console.warn(e);
    return;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  ["u_trail", "u_shock", "u_time", "u_radius", "u_vel", "u_glitch"].forEach(n => {
    u[n] = gl.getUniformLocation(prog, n);
  });

  // pixel lookup so particles only spawn from the body and take its colors
  let pixels = null, pw = 0, ph = 0;
  function bodyPixel(x, y) {
    if (!pixels || x < 0 || x >= 1 || y < 0 || y >= 1) return null;
    const i = ((y * ph | 0) * pw + (x * pw | 0)) * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    return Math.max(r, g, b) > 50 ? [r, g, b] : null;
  }

  const img = new Image();
  img.src = "/zerobro.png";
  img.onload = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    try {
      const off = document.createElement("canvas");
      pw = off.width = 360; ph = off.height = 360;
      const octx = off.getContext("2d");
      octx.drawImage(img, 0, 0, pw, ph);
      pixels = octx.getImageData(0, 0, pw, ph).data;
    } catch (e) { pixels = null; }

    stage.classList.add("gl");
    requestAnimationFrame(frame);
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    const fw = Math.round(innerWidth * dpr), fh = Math.round(innerHeight * dpr);
    if (fxCanvas.width !== fw || fxCanvas.height !== fh) {
      fxCanvas.width = fw; fxCanvas.height = fh;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ---- input ----
  const target = { x: 0.5, y: 0.5, s: 0 };
  const cur = { x: 0.5, y: 0.5, s: 0 };
  let clientX = 0, clientY = 0, inside = false, lastInput = -1e9;

  function onMove(x, y) {
    clientX = x; clientY = y;
    const r = stage.getBoundingClientRect();
    target.x = (x - r.left) / r.width;
    target.y = (y - r.top) / r.height;
    inside = target.x >= 0 && target.x <= 1 && target.y >= 0 && target.y <= 1;
    target.s = inside ? 1 : 0;
    if (inside) lastInput = performance.now();
  }
  window.addEventListener("pointermove", e => onMove(e.clientX, e.clientY), { passive: true });
  stage.addEventListener("pointerleave", () => { target.s = 0; inside = false; });
  window.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") { target.s = 0; inside = false; } });
  // a touch that turns into a page scroll is cancelled by the browser
  window.addEventListener("pointercancel", () => { target.s = 0; inside = false; });

  let shock = { x: 0.5, y: 0.5, born: -1 };
  let glitchUntil = 0, nextGlitch = performance.now() + 2500;
  stage.addEventListener("pointerdown", e => {
    onMove(e.clientX, e.clientY);
    const now = performance.now();
    shock = { x: target.x, y: target.y, born: now };
    glitchUntil = now + 320;
    burst(target.x, target.y, 90, 7);
  });

  // ---- particles ----
  const parts = [];
  function spawn(u0, v0, spread, speed, pvx, pvy) {
    if (parts.length > 700) return;
    const u1 = u0 + (Math.random() - 0.5) * spread;
    const v1 = v0 + (Math.random() - 0.5) * spread;
    const c = bodyPixel(u1, v1);
    if (!c) return;
    const r = stage.getBoundingClientRect();
    const a = Math.random() * Math.PI * 2;
    const sp = speed * (0.3 + Math.random());
    parts.push({
      x: r.left + u1 * r.width,
      y: r.top + v1 * r.height,
      vx: Math.cos(a) * sp + pvx * 0.35,
      vy: Math.sin(a) * sp + pvy * 0.35 - 0.6,
      life: 1,
      decay: 0.01 + Math.random() * 0.02,
      size: 2 + Math.random() * 5,
      c: `rgb(${Math.min(255, c[0] * 1.5 + 30) | 0},${Math.min(255, c[1] * 1.5 + 30) | 0},${Math.min(255, c[2] * 1.4 + 40) | 0})`,
    });
  }
  function burst(x, y, n, speed) {
    for (let i = 0; i < n * 3 && n > 0; i++) {
      const before = parts.length;
      spawn(x, y, RADIUS * 1.2, speed, 0, 0);
      if (parts.length > before) n--;
    }
  }
  function drawParticles() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalCompositeOperation = "lighter";
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.96; p.vy = p.vy * 0.96 - 0.04; // dissolve upward
      p.life -= p.decay;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      const s = p.size * (0.4 + p.life * 0.6);
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  // ---- loop ----
  const trail = Array.from({ length: TRAIL }, () => ({ x: 0.5, y: 0.5, w: 0 }));
  const trailBuf = new Float32Array(TRAIL * 3);
  let vel = 0, prevX = 0.5, prevY = 0.5;
  const start = performance.now();

  function frame(now) {
    resize();
    const t = (now - start) / 1000;

    // autopilot: a ghost cursor roams the body when nobody is touching it
    const idle = !inside && now - lastInput > 2500;
    if (idle) {
      target.x = 0.55 + 0.17 * Math.sin(t * 0.7);
      target.y = 0.5 + 0.24 * Math.sin(t * 0.53 + 1.0);
      target.s = 0.6;
    } else if (!inside) {
      target.s = 0;
    }

    const k = idle ? 0.06 : 0.22;
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    cur.s += (target.s - cur.s) * 0.08;

    const r = stage.getBoundingClientRect();
    const dx = (cur.x - prevX) * r.width, dy = (cur.y - prevY) * r.height;
    const spd = Math.hypot(dx, dy);
    prevX = cur.x; prevY = cur.y;
    vel += (Math.min(spd / 25, 1) - vel) * 0.2;

    trail.pop();
    trail.unshift({ x: cur.x, y: cur.y, w: cur.s });
    trail.forEach((p, i) => {
      trailBuf[i * 3] = p.x;
      trailBuf[i * 3 + 1] = p.y;
      trailBuf[i * 3 + 2] = p.w * Math.pow(1 - i / TRAIL, 1.6);
    });

    if (now > nextGlitch) {
      glitchUntil = now + 150 + Math.random() * 220;
      nextGlitch = now + 1800 + Math.random() * 3200;
    }

    // debris peeling off where the cursor touches
    if (cur.s > 0.3) {
      const n = idle ? (Math.random() < 0.5 ? 1 : 0) : Math.min(8, spd / 4 | 0) + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) spawn(cur.x, cur.y, RADIUS * 0.9, 1.2 + vel * 2, dx, dy);
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform3fv(u.u_trail, trailBuf);
    gl.uniform3f(u.u_shock, shock.x, shock.y, shock.born < 0 ? -1 : (now - shock.born) / 1000);
    gl.uniform1f(u.u_time, t);
    gl.uniform1f(u.u_radius, RADIUS);
    gl.uniform1f(u.u_vel, vel);
    gl.uniform1f(u.u_glitch, now < glitchUntil ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (shock.born >= 0 && now - shock.born > 3000) shock.born = -1;

    drawParticles();

    const size = RADIUS * 2 * r.width * (1 + vel * 0.25);
    ring.style.width = ring.style.height = size + "px";
    ring.style.transform = `translate(${clientX - size / 2}px, ${clientY - size / 2}px)`;
    ring.classList.toggle("on", inside);

    requestAnimationFrame(frame);
  }
})();
