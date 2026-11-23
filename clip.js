/* Bilden som sätter känslan. Lägg en ny fil som heter vibe.png i mappen
   om den ska användas istället. Annars går det att släppa en bild på sidan. */
const SOURCE_FILES = ["vibe.png", "vibe.webp", "inspo.png", "inspo.webp", "inspo_bild1.webp"];

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

const canvas = document.getElementById("frame");
const ctx = canvas.getContext("2d", { alpha: false });
const empty = document.getElementById("empty");
const status = document.getElementById("status");
const generateButton = document.getElementById("generate");
const downloadLink = document.getElementById("download");
const fileInput = document.getElementById("file");
const lengthButtons = document.querySelectorAll("[data-length]");
const params = document.getElementById("params");
const swatches = document.getElementById("swatches");
const tempoInput = document.getElementById("tempo");
const tempoRead = document.getElementById("tempo-read");
const photoButton = document.getElementById("photo");

canvas.width = WIDTH;
canvas.height = HEIGHT;

const INTRO = 7.6;

let duration = 10;
let tempo = 1;
let showPhoto = false;
let sourceImage = null;
let analysis = null;
let selected = [];
let sceneSeed = 1;
let scene = null;
let animTime = 0;
let clockTime = 0;
let lastFrame = 0;
let raf = 0;
let recording = false;
let downloadUrl = "";

const randOf = (seed) => {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const rgb = (color, alpha = 1) => `rgba(${color.r | 0}, ${color.g | 0}, ${color.b | 0}, ${alpha})`;

const loadImage = (blob) => new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Bilden gick inte att läsa."));
    };
    img.src = url;
});

const fetchSource = async () => {
    for (const name of SOURCE_FILES) {
        try {
            const response = await fetch(name);
            if (!response.ok) continue;
            const blob = await response.blob();
            if (!blob.type.startsWith("image/")) continue;
            return loadImage(blob);
        } catch {
            /* Nästa filnamn. Öppnas sidan som en fil kan webbläsaren inte läsa mappen. */
        }
    }
    if (typeof EMBEDDED_VIBE === "string") {
        const response = await fetch(EMBEDDED_VIBE);
        return loadImage(await response.blob());
    }
    return null;
};

const mix = (a, b, t) => ({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t
});

const colorDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

const lumOf = (color) => (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;

const satOf = (color) => {
    const max = Math.max(color.r, color.g, color.b);
    const min = Math.min(color.r, color.g, color.b);
    return max === 0 ? 0 : (max - min) / max;
};

/* Bilden bidrar med fältet och färgerna. Formen är alltid densamma:
   bollar i olika skärpa, utspridda i ett ljust fält. */
const readPalette = (image) => {
    const size = 140;
    const sample = document.createElement("canvas");
    sample.width = size;
    sample.height = size;
    const sampleCtx = sample.getContext("2d", { willReadFrequently: true });
    sampleCtx.drawImage(image, 0, 0, size, size);
    const { data } = sampleCtx.getImageData(0, 0, size, size);
    const at = (x, y) => {
        const index = (y * size + x) * 4;
        return { r: data[index], g: data[index + 1], b: data[index + 2] };
    };

    let bg = { r: 0, g: 0, b: 0 };
    let bgCount = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const color = at(x, y);
            if (satOf(color) < 0.18 && lumOf(color) > 0.76) {
                bg.r += color.r;
                bg.g += color.g;
                bg.b += color.b;
                bgCount += 1;
            }
        }
    }
    bg = bgCount
        ? { r: bg.r / bgCount, g: bg.g / bgCount, b: bg.b / bgCount }
        : { r: 236, g: 240, b: 226 };
    if (lumOf(bg) < 0.84) bg = mix(bg, { r: 255, g: 255, b: 255 }, 0.5);

    /* Platta färgfält inuti bollarna, inte den röda kanten runt dem. */
    const interiors = [];
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const color = at(x, y);
            if (colorDist(color, bg) < 40) continue;
            let variance = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) variance += colorDist(color, at(x + dx, y + dy));
            }
            if (variance / 9 < 20) interiors.push(color);
        }
    }

    const pool = interiors.length > 20 ? interiors : [];
    if (!pool.length) {
        for (let y = 0; y < size; y += 2) {
            for (let x = 0; x < size; x += 2) {
                const color = at(x, y);
                if (colorDist(color, bg) > 40) pool.push(color);
            }
        }
    }

    const seeds = [];
    pool.forEach((color, index) => {
        if (index % 2) return;
        const nearest = seeds.reduce((best, center) => Math.min(best, colorDist(center, color)), Infinity);
        if (nearest > 38) seeds.push({ ...color });
    });

    const groups = seeds.map(() => []);
    pool.forEach((color) => {
        let index = 0;
        let best = Infinity;
        seeds.forEach((center, i) => {
            const gap = colorDist(center, color);
            if (gap < best) {
                best = gap;
                index = i;
            }
        });
        if (groups[index]) groups[index].push(color);
    });

    const colors = [];
    groups.forEach((members) => {
        if (members.length < 4) return;
        members.sort((a, b) => satOf(b) - satOf(a));
        const color = members[0];
        if (colors.some((kept) => colorDist(kept, color) < 30)) return;
        colors.push(color);
    });
    colors.sort((a, b) => satOf(b) - satOf(a));
    const palette = colors.slice(0, 8);
    while (palette.length < 4) {
        const base = palette[palette.length - 1] || { r: 210, g: 70, b: 40 };
        palette.push(mix(base, bg, 0.35 + palette.length * 0.1));
    }

    const accent = palette.reduce((best, color) => (
        color.r - color.g * 0.45 - color.b * 0.55 > best.r - best.g * 0.45 - best.b * 0.55 ? color : best
    ));

    return { bg, colors: palette, accent };
};

const shuffle = (list, rand) => {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const hold = copy[i];
        copy[i] = copy[j];
        copy[j] = hold;
    }
    return copy;
};

const FIELD = [
    [0.08, 0.22], [0.24, 0.16], [0.4, 0.28], [0.56, 0.18], [0.72, 0.26], [0.9, 0.2],
    [0.12, 0.5], [0.3, 0.56], [0.48, 0.46], [0.66, 0.54], [0.86, 0.48],
    [0.18, 0.76], [0.4, 0.72], [0.62, 0.78], [0.84, 0.7]
];

/* Varje frö är en ny placering. Färgerna kommer alltid från samma bild. */
const buildScene = (palette, seed) => {
    const rand = randOf(seed);
    const colorRand = randOf((seed ^ 0x9e3779b9) >>> 0);
    const bag = shuffle(palette.colors, colorRand);
    let bagIndex = 0;
    const nextColor = () => {
        const color = bag[bagIndex % bag.length];
        bagIndex += 1;
        return color;
    };

    const plan = shuffle(["sharp", "sharp", "sharp", "sharp", "sharp", "sharp", "soft", "soft", "soft", "soft", "bokeh", "bokeh", "bokeh", "bokeh"], rand);
    const slots = shuffle(FIELD, rand);
    const orbs = plan.map((kind, index) => {
        const [sx, sy] = slots[index];
        const radius = kind === "sharp"
            ? 0.058 + rand() * 0.034
            : kind === "soft"
                ? 0.05 + rand() * 0.028
                : 0.072 + rand() * 0.03;
        return {
            kind,
            x: clamp(sx + (rand() - 0.5) * 0.1, -0.05, 1.05),
            y: clamp(sy + (rand() - 0.5) * 0.08, 0.05, 0.9),
            radius,
            fill: nextColor(),
            phase: rand() * Math.PI * 2,
            speed: 0.34 + rand() * 0.38,
            drift: kind === "sharp" ? 0.04 + rand() * 0.025 : 0.03 + rand() * 0.02,
            vx: (rand() - 0.5) * 0.022,
            vy: (rand() - 0.5) * 0.016,
            social: kind !== "sharp" || rand() < 0.7
        };
    });

    orbs.push({
        kind: "bloom",
        x: 0.18 + rand() * 0.1,
        y: 0.8 + rand() * 0.06,
        radius: 0.14 + rand() * 0.03,
        fill: palette.accent,
        phase: rand() * Math.PI * 2,
        speed: 0.22,
        drift: 0.03,
        vx: (rand() - 0.5) * 0.012,
        vy: -0.006,
        social: false
    }, {
        kind: "bloom",
        x: 0.62 + rand() * 0.12,
        y: 0.82 + rand() * 0.05,
        radius: 0.12 + rand() * 0.03,
        fill: palette.accent,
        phase: rand() * Math.PI * 2,
        speed: 0.18,
        drift: 0.028,
        vx: (rand() - 0.5) * 0.012,
        vy: -0.005,
        social: false
    });

    const sized = orbs.filter((orb) => orb.kind !== "bloom");
    if (sized[0]) sized[0].radius *= 1.34;
    if (sized[3]) sized[3].radius *= 1.16;

    const partners = orbs.filter((orb) => orb.social && orb.kind !== "bloom");
    for (let i = 0; i + 1 < partners.length && i < 4; i += 2) {
        const a = partners[i];
        const b = partners[i + 1];
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const dist = 0.09 + rand() * 0.035;
        const spin = 0.42 + rand() * 0.28;
        a.couple = { cx, cy, phase: rand() * Math.PI * 2, dist, spin, vx: a.vx, vy: a.vy };
        b.couple = { cx, cy, phase: a.couple.phase + Math.PI, dist, spin, vx: a.vx, vy: a.vy };
    }

    const smears = [0, 1, 2].map(() => ({
        x: rand(),
        y: 0.12 + rand() * 0.76,
        length: 0.38 + rand() * 0.38,
        thick: 0.045 + rand() * 0.05,
        angle: -0.5 + rand() * 1.1,
        color: nextColor(),
        phase: rand() * Math.PI * 2,
        speed: 0.18 + rand() * 0.16
    }));

    const dark = palette.colors.filter((color) => lumOf(color) < 0.32).sort((a, b) => lumOf(a) - lumOf(b))[0];
    const sharpOrb = orbs.find((orb) => orb.kind === "sharp");
    if (dark && sharpOrb) sharpOrb.fill = dark;

    const lightRim = palette.colors.reduce((best, color) => (
        lumOf(color) > 0.35 && satOf(color) > satOf(best) ? color : best
    ));

    const bright = palette.colors.filter((color) => lumOf(color) > 0.34);
    orbs.forEach((orb) => {
        if (orb.kind !== "sharp") return;
        const darkFill = lumOf(orb.fill) < 0.3;
        const alternate = bright.length ? bright[(rand() * bright.length) | 0] : palette.accent;
        orb.rim = darkFill ? lightRim : (rand() < 0.75 ? palette.accent : alternate);
        orb.halo = darkFill ? lightRim : palette.accent;
    });

    return { bg: palette.bg, accent: palette.accent, orbs, smears };
};

const pointOf = (orb, time, width, height) => {
    const unit = Math.min(width, height);
    const radius = orb.radius * unit * (1 + Math.sin(time * orb.speed * 0.85 + orb.phase) * 0.07);
    if (orb.couple) {
        const couple = orb.couple;
        const angle = couple.phase + time * couple.spin;
        const breathe = 0.55 + (Math.sin(time * couple.spin * 0.65) + 1) * 0.38;
        return {
            x: couple.cx * width + (time * couple.vx + Math.cos(angle) * couple.dist * breathe) * unit,
            y: couple.cy * height + (time * couple.vy + Math.sin(angle) * couple.dist * 0.7 * breathe) * unit,
            radius
        };
    }
    return {
        x: orb.x * width + (Math.sin(time * orb.speed + orb.phase) * orb.drift + time * orb.vx) * unit,
        y: orb.y * height + (Math.cos(time * orb.speed * 0.7 + orb.phase) * orb.drift * 0.75 + time * orb.vy) * unit,
        radius
    };
};

const makeGrain = (size, amount) => {
    const tile = document.createElement("canvas");
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext("2d");
    const pixels = tileCtx.createImageData(size, size);
    for (let i = 0; i < pixels.data.length; i += 4) {
        const value = 128 + (Math.random() - 0.5) * amount;
        pixels.data[i] = value;
        pixels.data[i + 1] = value;
        pixels.data[i + 2] = value;
        pixels.data[i + 3] = 255;
    }
    tileCtx.putImageData(pixels, 0, 0);
    return tile;
};

const fineGrain = makeGrain(280, 118);
const coarseGrain = makeGrain(140, 52);

const drawSmear = (smear, time, width, height) => {
    const x = (smear.x + Math.sin(time * smear.speed + smear.phase) * 0.08) * width;
    const y = (smear.y + Math.cos(time * smear.speed * 0.6 + smear.phase) * 0.05) * height;
    const length = smear.length * Math.min(width, height);
    const thick = smear.thick * height;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(smear.angle + Math.sin(time * 0.15 + smear.phase) * 0.08);
    ctx.filter = "blur(16px)";
    const fade = ctx.createLinearGradient(-length / 2, 0, length / 2, 0);
    fade.addColorStop(0, rgb(smear.color, 0));
    fade.addColorStop(0.45, rgb(smear.color, 0.16));
    fade.addColorStop(1, rgb(smear.color, 0));
    ctx.fillStyle = fade;
    ctx.fillRect(-length / 2, -thick / 2, length, thick);
    ctx.restore();
};

const drawGrain = (width, height, amount) => {
    if (amount < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.filter = "none";
    ctx.globalAlpha = 0.34 * amount;
    for (let y = 0; y < height; y += 280) {
        for (let x = 0; x < width; x += 280) ctx.drawImage(fineGrain, x, y);
    }
    ctx.globalAlpha = 0.1 * amount;
    for (let y = 0; y < height; y += 140) {
        for (let x = 0; x < width; x += 140) ctx.drawImage(coarseGrain, x, y);
    }
    ctx.restore();
};

/* När två sociala bollar nuddar varandra växer en mjuk hals mellan dem. */
const drawMerge = (a, b) => {
    if (!a.orb.social || !b.orb.social) return;
    if (a.orb.kind === "bloom" || b.orb.kind === "bloom") return;
    const r1 = a.radius;
    const r2 = b.radius;
    const smaller = Math.min(r1, r2);
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const gap = distance - r1 - r2;
    if (gap > smaller * 0.28 || distance < 2 || Math.max(r1, r2) > smaller * 2.1) return;

    const closeness = clamp(1 - gap / (smaller * 0.28), 0, 1);
    const neck = smaller * (0.7 + closeness * 0.55);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = neck * 2;
    ctx.filter = "blur(10px)";
    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    gradient.addColorStop(0.15, rgb(a.orb.fill, 1));
    gradient.addColorStop(0.5, rgb(mix(a.orb.fill, b.orb.fill, 0.5), 1));
    gradient.addColorStop(0.85, rgb(b.orb.fill, 1));
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
};

/* En liten virvel av de två färgerna, ovanpå mötet. */
const drawSwirl = (a, b, time) => {
    if (!a.orb.social || !b.orb.social) return;
    if (a.orb.kind === "bloom" || b.orb.kind === "bloom") return;
    const smaller = Math.min(a.radius, b.radius);
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const gap = distance - a.radius - b.radius;
    if (gap > smaller * 0.28 || distance < 2 || Math.max(a.radius, b.radius) > smaller * 2.1) return;
    const closeness = clamp(1 - gap / (smaller * 0.28), 0, 1);
    if (closeness < 0.45) return;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const spin = Math.atan2(b.y - a.y, b.x - a.x) + time * 0.55;
    const offset = smaller * 0.22 * closeness;
    const lobe = smaller * (0.32 + closeness * 0.26);
    ctx.save();
    ctx.filter = "blur(8px)";
    [
        [Math.cos(spin), Math.sin(spin), a.orb.fill],
        [-Math.cos(spin), -Math.sin(spin), b.orb.fill]
    ].forEach(([dx, dy, color]) => {
        const x = mx + dx * offset;
        const y = my + dy * offset;
        const eddy = ctx.createRadialGradient(x, y, 0, x, y, lobe);
        eddy.addColorStop(0, rgb(color, 0.8));
        eddy.addColorStop(1, rgb(color, 0));
        ctx.fillStyle = eddy;
        ctx.beginPath();
        ctx.arc(x, y, lobe, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
};

const gather = (points) => {
    points.forEach((point) => {
        point.homeX = point.x;
        point.homeY = point.y;
    });
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const a = points[i];
            const b = points[j];
            if (!a.orb.social || !b.orb.social) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distance = Math.hypot(dx, dy) || 1;
            const reach = (a.radius + b.radius) * 1.7;
            if (distance > reach) continue;
            const pull = (1 - distance / reach) * 0.34;
            a.x += dx * pull * 0.5;
            a.y += dy * pull * 0.5;
            b.x -= dx * pull * 0.5;
            b.y -= dy * pull * 0.5;
        }
    }
};

const radial = (x, y, inner, outer, color, innerAlpha, outerAlpha) => {
    const gradient = ctx.createRadialGradient(x, y, Math.max(0, inner), x, y, Math.max(inner + 1, outer));
    gradient.addColorStop(0, rgb(color, innerAlpha));
    gradient.addColorStop(1, rgb(color, outerAlpha));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, outer, 0, Math.PI * 2);
    ctx.fill();
};

const ease = (value) => value * value * value * (value * (value * 6 - 15) + 10);

/* Bilden hålls kvar, mjuknar långsamt och glider över i bollarna. */
const openingOf = (clock) => {
    if (!showPhoto || !sourceImage) return { blur: 1, grain: 1, photo: 0, orbs: 1 };
    const span = recording ? Math.min(INTRO, Math.max(4.6, duration * 0.68)) : INTRO;
    const stage = clamp(clock / span, 0, 1);
    const blur = ease(clamp((stage - 0.18) / 0.46, 0, 1));
    const grain = stage < 0.14 ? 0 : ease(clamp((stage - 0.14) / 0.4, 0, 1));
    const photo = 1 - ease(clamp((stage - 0.5) / 0.5, 0, 1));
    const orbs = ease(clamp((stage - 0.42) / 0.48, 0, 1));
    return { blur, grain: Math.max(grain, orbs), photo, orbs };
};

const drawPhoto = (image, width, height, blur) => {
    const blurPx = blur * 36;
    const bleed = blurPx * 1.8;
    const scale = Math.max(width / image.width, height / image.height);
    const w = image.width * scale + bleed * 2;
    const h = image.height * scale + bleed * 2;
    ctx.save();
    ctx.filter = blurPx > 0.4 ? `blur(${blurPx}px)` : "none";
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
    ctx.restore();
};

const paint = (time, clock, fade) => {
    const { width, height } = canvas;
    const open = openingOf(clock);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = rgb(scene.bg);
    ctx.fillRect(0, 0, width, height);

    if (sourceImage && open.photo > 0.004) {
        ctx.globalAlpha = open.photo;
        drawPhoto(sourceImage, width, height, open.blur);
        if (open.blur > 0.12) {
            ctx.globalAlpha = open.photo * open.blur * 0.28;
            ctx.fillStyle = rgb(scene.bg);
            ctx.fillRect(0, 0, width, height);
        }
        if (open.blur > 0.08) {
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            const span = Math.min(width, height) * (0.06 + open.blur * 0.34);
            const edges = [
                [0, 0, span, 0, 0, 0, span, height],
                [width, 0, width - span, 0, width - span, 0, span, height],
                [0, 0, 0, span, 0, 0, width, span],
                [0, height, 0, height - span, 0, height - span, width, span]
            ];
            edges.forEach(([x0, y0, x1, y1, x, y, w, h]) => {
                const fade = ctx.createLinearGradient(x0, y0, x1, y1);
                fade.addColorStop(0, rgb(scene.bg, 1));
                fade.addColorStop(1, rgb(scene.bg, 0));
                ctx.fillStyle = fade;
                ctx.fillRect(x, y, w, h);
            });
        }
        ctx.globalAlpha = 1;
        ctx.filter = "none";
    }

    if (open.orbs < 0.01) {
        drawGrain(width, height, open.grain);
        if (fade > 0) {
            ctx.globalAlpha = fade;
            ctx.fillStyle = rgb(scene.bg);
            ctx.fillRect(0, 0, width, height);
            ctx.globalAlpha = 1;
        }
        return;
    }

    ctx.save();
    ctx.globalAlpha = open.orbs;

    radial(width * 0.5, height * 0.28, 0, height * 0.72, { r: 255, g: 255, b: 255 }, 0.22, 0);
    scene.smears.forEach((smear) => drawSmear(smear, time, width, height));
    ctx.filter = "none";

    const order = { bloom: 0, bokeh: 1, soft: 2, sharp: 3 };
    const points = scene.orbs.map((orb) => ({ orb, ...pointOf(orb, time, width, height) }));
    gather(points);
    const swellOf = points.map((point) => {
        if (point.orb.kind === "bloom" || !point.orb.social) return 0;
        let swell = 0;
        points.forEach((other) => {
            if (other === point || !other.orb.social || other.orb.kind === "bloom") return;
            const distance = Math.hypot(other.x - point.x, other.y - point.y);
            const smaller = Math.min(point.radius, other.radius);
            const gap = distance - point.radius - other.radius;
            const reach = smaller * 0.75;
            if (gap < reach) swell = Math.max(swell, clamp(1 - Math.max(gap, 0) / reach, 0, 1));
        });
        return swell;
    });
    points.forEach((point, index) => {
        point.radius *= 1 + swellOf[index] * 0.34;
    });
    points.sort((a, b) => order[a.orb.kind] - order[b.orb.kind]);
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) drawMerge(points[i], points[j]);
    }
    ctx.filter = "none";

    const meltOf = (point) => {
        let melt = 0;
        points.forEach((other) => {
            if (other === point || other.orb.kind === "bloom") return;
            const distance = Math.hypot(other.x - point.x, other.y - point.y);
            const smaller = Math.min(point.radius, other.radius);
            const gap = distance - point.radius - other.radius;
            const reach = smaller * 1.45;
            if (gap < reach) melt = Math.max(melt, clamp(1 - gap / reach, 0, 1));
        });
        return melt;
    };

    points.forEach((point) => {
        const orb = point.orb;
        const melt = orb.kind === "sharp" ? meltOf(point) : 0;
        if (orb.kind === "bloom") {
            radial(point.x, point.y, point.radius * 0.35, point.radius * 1.15, mix(scene.bg, scene.accent, 0.62), 0.55, 0);
            return;
        }
        if (orb.kind === "bokeh") {
            const color = mix(orb.fill, scene.bg, 0.15);
            radial(point.x, point.y, point.radius * 0.28, point.radius * 1.2, color, 0.82, 0);
            return;
        }
        if (orb.kind === "soft") {
            radial(point.x, point.y, point.radius * 0.45, point.radius * 1.15, orb.fill, 0.96, 0);
            return;
        }

        const softness = 0.22 + melt * 0.78;
        radial(
            point.x,
            point.y,
            point.radius * (0.72 - softness * 0.28),
            point.radius * (1.45 + softness * 0.35),
            orb.halo,
            0.28 + softness * 0.18,
            0
        );
        const core = mix(orb.fill, { r: 255, g: 255, b: 255 }, 0.08 * (1 - melt));
        const body = ctx.createRadialGradient(point.x, point.y, point.radius * 0.2, point.x, point.y, point.radius * (1 + melt * 0.12));
        body.addColorStop(0, rgb(core, 1));
        body.addColorStop(0.55 + (1 - melt) * 0.2, rgb(orb.fill, 0.98));
        body.addColorStop(1, rgb(orb.fill, 0));
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius * (1 + melt * 0.12), 0, Math.PI * 2);
        ctx.fill();

        const rimAlpha = 0.55 * ((1 - melt) ** 2);
        if (rimAlpha > 0.04) {
            const ring = ctx.createRadialGradient(
                point.x,
                point.y,
                point.radius * 0.58,
                point.x,
                point.y,
                point.radius * 1.28
            );
            ring.addColorStop(0, rgb(orb.rim, 0));
            ring.addColorStop(0.5, rgb(orb.rim, rimAlpha));
            ring.addColorStop(1, rgb(orb.rim, 0));
            ctx.fillStyle = ring;
            ctx.beginPath();
            ctx.arc(point.x, point.y, point.radius * 1.08, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) drawSwirl(points[i], points[j], time);
    }
    ctx.restore();
    ctx.filter = "none";
    ctx.globalAlpha = 1;

    drawGrain(width, height, open.grain);

    if (fade > 0) {
        ctx.globalAlpha = fade;
        ctx.fillStyle = rgb(scene.bg);
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1;
    }
};

const applyBackground = () => {
    document.documentElement.style.setProperty("--bg", rgb(scene.bg));
};

const tempoWord = (value) => {
    if (value < 0.75) return "Långsamt";
    if (value > 1.25) return "Snabbt";
    return "Medel";
};

const activePalette = () => {
    const colors = analysis.colors.filter((_, index) => selected[index]);
    const accent = colors.includes(analysis.accent)
        ? analysis.accent
        : colors.reduce((best, color) => (satOf(color) > satOf(best) ? color : best));
    return { bg: analysis.bg, colors, accent };
};

const hexOf = (color) => {
    const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
    return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
};

const colorOf = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
});

const repaintScene = () => {
    scene = buildScene(activePalette(), sceneSeed);
    applyBackground();
};

const renderSwatches = () => {
    swatches.replaceChildren();
    analysis.colors.forEach((color, index) => {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.dataset.on = selected[index] ? "true" : "false";

        const hide = document.createElement("button");
        hide.type = "button";
        hide.className = "dot-hide";
        hide.setAttribute("aria-pressed", selected[index] ? "true" : "false");
        hide.setAttribute("aria-label", selected[index] ? "Dölj färgen" : "Visa färgen");
        hide.addEventListener("click", () => {
            if (recording) return;
            const on = selected.filter(Boolean).length;
            if (selected[index] && on === 1) return;
            selected[index] = !selected[index];
            dot.dataset.on = selected[index] ? "true" : "false";
            hide.setAttribute("aria-pressed", selected[index] ? "true" : "false");
            hide.setAttribute("aria-label", selected[index] ? "Dölj färgen" : "Visa färgen");
            repaintScene();
        });

        const input = document.createElement("input");
        input.type = "color";
        input.className = "swatch";
        input.value = hexOf(color);
        input.setAttribute("aria-label", "Ändra färg");
        input.addEventListener("input", () => {
            if (recording) return;
            analysis.colors[index] = colorOf(input.value);
            if (selected[index]) analysis.accent = analysis.colors[index];
            repaintScene();
        });

        dot.append(hide, input);
        swatches.append(dot);
    });
};

const setBusy = (busy) => {
    generateButton.disabled = busy || !scene;
    lengthButtons.forEach((button) => {
        button.disabled = busy;
    });
    swatches.querySelectorAll("button, input").forEach((control) => {
        control.disabled = busy;
    });
    tempoInput.disabled = busy;
    photoButton.disabled = busy;
};

const preview = (now) => {
    if (recording) return;
    if (!lastFrame) lastFrame = now;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    animTime += dt * tempo;
    clockTime += dt;
    paint(animTime, clockTime, 0);
    raf = requestAnimationFrame(preview);
};

const showScene = (next, message) => {
    scene = next;
    applyBackground();
    canvas.hidden = false;
    empty.hidden = true;
    params.hidden = false;
    generateButton.disabled = false;
    status.textContent = message;
    cancelAnimationFrame(raf);
    animTime = 0;
    clockTime = 0;
    lastFrame = 0;
    raf = requestAnimationFrame(preview);
};

const useImage = (image) => {
    if (recording) return;
    sourceImage = image;
    analysis = readPalette(image);
    selected = analysis.colors.map(() => true);
    sceneSeed = (Math.random() * 1e9) | 0;
    renderSwatches();
    showScene(buildScene(activePalette(), sceneSeed), "");
};

const mimeType = () => {
    const types = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4"
    ];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
};

const startAmbience = (audioCtx, destination) => {
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    master.gain.linearRampToValueAtTime(0.11, audioCtx.currentTime + 1.1);
    master.gain.setValueAtTime(0.11, audioCtx.currentTime + Math.max(1.2, duration - 1.3));
    master.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    master.connect(destination);
    master.connect(audioCtx.destination);

    const brightness = (scene.bg.r + scene.bg.g + scene.bg.b) / (255 * 3);
    const base = 146 + brightness * 40;
    const nodes = [0, 4, 7].map((semi, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        osc.type = index === 2 ? "triangle" : "sine";
        osc.frequency.value = base * (2 ** (semi / 12));
        osc.detune.value = (index - 1) * 7;
        gain.gain.value = index === 0 ? 0.55 : 0.18;
        filter.type = "lowpass";
        filter.frequency.value = 520;
        lfo.frequency.value = 0.04 + index * 0.025;
        lfoGain.gain.value = 140;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        osc.connect(gain);
        gain.connect(filter);
        filter.connect(master);
        osc.start();
        lfo.start();
        return { osc, lfo };
    });

    const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    const band = audioCtx.createBiquadFilter();
    const noiseGain = audioCtx.createGain();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    band.type = "bandpass";
    band.frequency.value = 740;
    band.Q.value = 0.6;
    noiseGain.gain.value = 0.035;
    noise.connect(band);
    band.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();

    return () => {
        nodes.forEach(({ osc, lfo }) => {
            osc.stop();
            lfo.stop();
        });
        noise.stop();
        master.disconnect();
    };
};

const recordClip = async () => {
    if (!scene || recording) return;
    const type = mimeType();
    if (!type || !canvas.captureStream) {
        status.textContent = "Den här webbläsaren kan inte spara klippet.";
        return;
    }

    recording = true;
    setBusy(true);
    downloadLink.hidden = true;
    cancelAnimationFrame(raf);

    sceneSeed = (Math.random() * 1e9) | 0;
    scene = buildScene(activePalette(), sceneSeed);

    const audioCtx = new AudioContext();
    await audioCtx.resume();
    const audioDest = audioCtx.createMediaStreamDestination();
    const stopAudio = startAmbience(audioCtx, audioDest);

    const stream = new MediaStream([
        ...canvas.captureStream(FPS).getVideoTracks(),
        ...audioDest.stream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
    };

    const extension = type.includes("mp4") ? "mp4" : "webm";
    const done = new Promise((resolve) => {
        recorder.onstop = () => resolve();
    });

    const started = performance.now();
    let clipTime = 0;
    let lastTick = started;
    const elapsed = () => Math.max(0, (performance.now() - started) / 1000);
    const tick = () => {
        const now = performance.now();
        const time = elapsed();
        clipTime += Math.min(0.05, (now - lastTick) / 1000) * tempo;
        lastTick = now;
        const fadeOut = time > duration - 0.8 ? (time - (duration - 0.8)) / 0.8 : 0;
        paint(clipTime, time, clamp(fadeOut, 0, 1));
        status.textContent = `Spelar in ${Math.min(duration, Math.ceil(time))} / ${duration} s`;
        if (time >= duration) return;
        raf = requestAnimationFrame(tick);
    };

    recorder.start();
    raf = requestAnimationFrame(tick);

    await new Promise((resolve) => {
        const wait = () => {
            if (elapsed() >= duration) resolve();
            else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
    });

    cancelAnimationFrame(raf);
    paint(clipTime, duration, 1);
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    stopAudio();
    await audioCtx.close();

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    const blob = new Blob(chunks, { type: type });
    downloadUrl = URL.createObjectURL(blob);
    downloadLink.href = downloadUrl;
    downloadLink.download = `wsk-klipp.${extension}`;
    downloadLink.hidden = false;

    recording = false;
    setBusy(false);
    status.textContent = "Klipp klart.";
    animTime = clipTime;
    lastFrame = 0;
    raf = requestAnimationFrame(preview);
};

lengthButtons.forEach((button) => {
    button.addEventListener("click", () => {
        if (recording) return;
        duration = Number(button.dataset.length);
        lengthButtons.forEach((item) => {
            item.setAttribute("aria-pressed", item === button ? "true" : "false");
        });
    });
});

tempoInput.addEventListener("input", () => {
    tempo = Number(tempoInput.value);
    tempoRead.textContent = tempoWord(tempo);
    tempoInput.setAttribute("aria-valuenow", tempoInput.value);
});

photoButton.addEventListener("click", () => {
    if (recording) return;
    showPhoto = !showPhoto;
    photoButton.setAttribute("aria-pressed", showPhoto ? "true" : "false");
    if (showPhoto) {
        animTime = 0;
        clockTime = 0;
        lastFrame = 0;
    }
});

generateButton.addEventListener("click", () => {
    recordClip().catch(() => {
        recording = false;
        setBusy(false);
        status.textContent = "Inspelningen avbröts.";
    });
});

document.getElementById("swap").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const [file] = fileInput.files || [];
    if (file) loadImage(file).then(useImage).catch(() => {
        status.textContent = "Bilden gick inte att läsa.";
    });
    fileInput.value = "";
});

const dropTarget = document.body;

dropTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropTarget.classList.add("drag");
});

dropTarget.addEventListener("dragleave", (event) => {
    if (!dropTarget.contains(event.relatedTarget)) dropTarget.classList.remove("drag");
});

dropTarget.addEventListener("drop", (event) => {
    event.preventDefault();
    dropTarget.classList.remove("drag");
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
    if (!file) return;
    loadImage(file).then(useImage).catch(() => {
        status.textContent = "Bilden gick inte att läsa.";
    });
});

fetchSource().then((image) => {
    if (image) useImage(image);
    else {
        empty.textContent = "Släpp en png här, eller lägg vibe.png i mappen.";
        status.textContent = "";
    }
});
