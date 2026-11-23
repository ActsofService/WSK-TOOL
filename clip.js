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
const stillButton = document.getElementById("still");
const downloadLink = document.getElementById("download");
const fileInput = document.getElementById("file");
const lengthButtons = document.querySelectorAll("[data-length]");
const formatButtons = document.querySelectorAll("[data-format]");
const params = document.getElementById("params");
const swatches = document.getElementById("swatches");
const counts = document.getElementById("counts");
const tempoButtons = document.querySelectorAll("[data-tempo]");
const groundInput = document.getElementById("ground");
const groundChip = document.getElementById("ground-chip");
const groundOpen = document.getElementById("ground-open");
const hexInput = document.getElementById("hex");
const groundHex = document.getElementById("ground-hex");
const photoButton = document.getElementById("photo");
const loopButton = document.getElementById("loop");

canvas.width = WIDTH;
canvas.height = HEIGHT;

const INTRO = 7.6;

let duration = 10;

/* Korta klipp är ett varv. Längre loopar upprepar samma varv. */
const loopCycle = () => (loopOn && duration > 15 ? 10 : duration);

const lengthText = (seconds) => {
    const whole = Math.max(0, Math.round(seconds));
    if (whole >= 60 && whole % 60 === 0) return `${whole / 60} min`;
    if (whole > 60) return `${Math.floor(whole / 60)} min ${whole % 60} s`;
    return `${whole} s`;
};

const videoBitrate = () => {
    if (duration <= 30) return 36_000_000;
    const target = 190 * 1024 * 1024;
    return Math.max(5_000_000, Math.min(24_000_000, Math.round((target * 8) / duration)));
};
let format = "webm";
let tempo = 1;
let showPhoto = false;
let loopOn = false;
let sourceImage = null;
let analysis = null;
let selected = [];
let hexIndex = 0;
let sceneSeed = 1;
let scene = null;
let animTime = 0;
let clockTime = 0;
let lastFrame = 0;
let raf = 0;
let recording = false;
let downloadUrl = "";
let stillCount = 0;

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
    [0.07, 0.16], [0.22, 0.12], [0.38, 0.2], [0.54, 0.11], [0.7, 0.18], [0.88, 0.14],
    [0.1, 0.38], [0.26, 0.34], [0.44, 0.42], [0.6, 0.32], [0.76, 0.4], [0.93, 0.36],
    [0.06, 0.58], [0.22, 0.64], [0.4, 0.54], [0.56, 0.62], [0.74, 0.56], [0.9, 0.66],
    [0.14, 0.8], [0.32, 0.76], [0.5, 0.84], [0.68, 0.74], [0.86, 0.82]
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

    const kinds = [
        "sharp", "sharp", "sharp", "sharp", "sharp", "sharp", "sharp",
        "soft", "soft", "soft", "soft", "soft", "soft", "soft", "soft",
        "bokeh", "bokeh", "bokeh", "bokeh", "bokeh", "bokeh", "bokeh"
    ];
    const plan = shuffle(kinds, rand);
    const slots = shuffle(FIELD, rand);
    const orbs = plan.map((kind, index) => {
        const [sx, sy] = slots[index];
        const radius = kind === "sharp"
            ? 0.05 + rand() * 0.1
            : kind === "soft"
                ? 0.058 + rand() * 0.095
                : 0.082 + rand() * 0.11;
        return {
            kind,
            x: clamp(sx + (rand() - 0.5) * 0.07, 0.02, 0.98),
            y: clamp(sy + (rand() - 0.5) * 0.06, 0.06, 0.92),
            radius,
            fill: nextColor(),
            phase: rand() * Math.PI * 2,
            speed: 0.24 + rand() * 0.28,
            drift: kind === "sharp" ? 0.055 + rand() * 0.04 : 0.048 + rand() * 0.034,
            social: kind !== "sharp" || rand() < 0.85,
            meets: []
        };
    });

    orbs.push({
        kind: "bloom",
        x: 0.18 + rand() * 0.1,
        y: 0.8 + rand() * 0.06,
        radius: 0.16 + rand() * 0.05,
        fill: palette.accent,
        phase: rand() * Math.PI * 2,
        speed: 0.16,
        drift: 0.035,
        social: false
    }, {
        kind: "bloom",
        x: 0.62 + rand() * 0.12,
        y: 0.82 + rand() * 0.05,
        radius: 0.15 + rand() * 0.04,
        fill: palette.accent,
        phase: rand() * Math.PI * 2,
        speed: 0.14,
        drift: 0.03,
        social: false
    });

    const sized = orbs.filter((orb) => orb.kind !== "bloom");
    if (sized[0]) sized[0].radius = Math.min(0.26, sized[0].radius * 1.6);
    if (sized[2]) sized[2].radius = Math.max(0.022, sized[2].radius * 0.45);
    if (sized[5]) sized[5].radius = Math.min(0.2, sized[5].radius * 1.35);
    if (sized[8]) sized[8].radius = Math.min(0.18, sized[8].radius * 1.25);

    const socials = orbs.filter((orb) => orb.social && orb.kind !== "bloom");
    const spanOf = (a, b) => Math.hypot((a.x - b.x) * (WIDTH / HEIGHT), a.y - b.y);
    const degree = new Map();
    const linked = new Set();
    const edges = [];
    for (let i = 0; i < socials.length; i++) {
        for (let j = i + 1; j < socials.length; j++) {
            edges.push({ a: socials[i], b: socials[j], dist: spanOf(socials[i], socials[j]) });
        }
    }
    edges.sort((a, b) => a.dist - b.dist);
    const link = (maxDegree, maxLinks, maxDist) => {
        let made = 0;
        edges.forEach((edge) => {
            if (made >= maxLinks || edge.dist > maxDist) return;
            const key = edge.a.x + ":" + edge.b.x + ":" + edge.a.y + ":" + edge.b.y;
            if (linked.has(key)) return;
            const da = degree.get(edge.a) || 0;
            const db = degree.get(edge.b) || 0;
            if (da >= maxDegree || db >= maxDegree) return;
            linked.add(key);
            degree.set(edge.a, da + 1);
            degree.set(edge.b, db + 1);
            const phase = rand() * Math.PI * 2;
            const spin = 0.34 + rand() * 0.22;
            edge.a.meets.push({ other: edge.b, phase, spin });
            edge.b.meets.push({ other: edge.a, phase, spin });
            made += 1;
        });
    };
    link(1, 8, 0.72);
    link(2, 5, 0.58);

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

/* En loop är ett långsamt varv. Den är tillbaka av sig själv, utan ett ryck på slutet. */
const motion = (time, omega, phase) => {
    if (!loopOn) return time * omega + phase;
    return phase + (time / loopCycle()) * Math.PI * 2;
};

/* Varje boll vandrar runt sin plats. Par som redan står nära går ihop och tillbaka. */
const pointOf = (orb, time, width, height) => {
    const unit = Math.min(width, height);
    const sway = loopOn ? 0.45 : 1;
    const radius = orb.radius * unit * (1 + Math.sin(motion(time, orb.speed * 0.85, orb.phase)) * 0.06);
    const roamX = Math.sin(motion(time, orb.speed, orb.phase)) * orb.drift * sway
        + Math.sin(motion(time, orb.speed * 0.37, orb.phase * 1.7)) * orb.drift * 0.45 * sway;
    const roamY = Math.cos(motion(time, orb.speed * 0.72, orb.phase)) * orb.drift * 0.7 * sway
        + Math.cos(motion(time, orb.speed * 0.29, orb.phase * 2.1)) * orb.drift * 0.4 * sway;
    let x = orb.x;
    let y = orb.y;
    const meetReach = loopOn ? 0.18 : 0.52;
    (orb.meets || []).forEach((meet) => {
        const amount = 0.5 - 0.5 * Math.cos(motion(time, meet.spin, meet.phase));
        x += (meet.other.x - orb.x) * meetReach * amount;
        y += (meet.other.y - orb.y) * meetReach * amount;
    });
    return {
        x: x * width + roamX * unit,
        y: y * height + roamY * unit,
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
    const sway = loopOn ? 0.45 : 1;
    const x = (smear.x + Math.sin(motion(time, smear.speed, smear.phase)) * 0.08 * sway) * width;
    const y = (smear.y + Math.cos(motion(time, smear.speed * 0.6, smear.phase)) * 0.05 * sway) * height;
    const length = smear.length * Math.min(width, height);
    const thick = smear.thick * height;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(smear.angle + Math.sin(motion(time, 0.15, smear.phase)) * 0.08 * sway);
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

let linkCanvas = null;
let linkCtx = null;
let linkDrawn = false;

const linkLayer = (width, height) => {
    if (!linkCanvas) {
        linkCanvas = document.createElement("canvas");
        linkCtx = linkCanvas.getContext("2d");
    }
    if (linkCanvas.width !== width || linkCanvas.height !== height) {
        linkCanvas.width = width;
        linkCanvas.height = height;
    } else {
        linkCtx.clearRect(0, 0, width, height);
    }
    linkDrawn = false;
    return linkCtx;
};

/* Ett mjukt streck tonar fram när två bollar möts, och försvinner när de glider isär. */
const drawMerge = (a, b) => {
    if (!a.orb.social || !b.orb.social) return;
    if (a.orb.kind === "bloom" || b.orb.kind === "bloom") return;
    const r1 = a.radius;
    const r2 = b.radius;
    const smaller = Math.min(r1, r2);
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const gap = distance - r1 - r2;
    const reach = smaller * 1.15;
    if (gap > reach || distance < 2 || Math.max(r1, r2) > smaller * 3) return;

    const closeness = ease(clamp(1 - gap / reach, 0, 1));
    if (closeness < 0.02) return;
    const neck = smaller * closeness * (0.42 + closeness * 0.5);
    linkCtx.lineCap = "round";
    linkCtx.lineWidth = neck * 2;
    const gradient = linkCtx.createLinearGradient(a.x, a.y, b.x, b.y);
    gradient.addColorStop(0.15, rgb(a.orb.fill, closeness));
    gradient.addColorStop(0.5, rgb(mix(a.orb.fill, b.orb.fill, 0.5), closeness));
    gradient.addColorStop(0.85, rgb(b.orb.fill, closeness));
    linkCtx.strokeStyle = gradient;
    linkCtx.beginPath();
    linkCtx.moveTo(a.x, a.y);
    linkCtx.lineTo(b.x, b.y);
    linkCtx.stroke();
    linkDrawn = true;
};

/* En liten virvel av de två färgerna, ovanpå mötet. */
const drawSwirl = (a, b, time) => {
    if (!a.orb.social || !b.orb.social) return;
    if (a.orb.kind === "bloom" || b.orb.kind === "bloom") return;
    const smaller = Math.min(a.radius, b.radius);
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const gap = distance - a.radius - b.radius;
    const reach = smaller * 1.15;
    if (gap > reach || distance < 2 || Math.max(a.radius, b.radius) > smaller * 3) return;
    const closeness = ease(clamp(1 - gap / reach, 0, 1));
    if (closeness < 0.08) return;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const spin = Math.atan2(b.y - a.y, b.x - a.x) + motion(time, 0.55, 0);
    const offset = smaller * 0.22 * closeness;
    const lobe = smaller * closeness * (0.34 + closeness * 0.28);
    [
        [Math.cos(spin), Math.sin(spin), a.orb.fill],
        [-Math.cos(spin), -Math.sin(spin), b.orb.fill]
    ].forEach(([dx, dy, color]) => {
        const x = mx + dx * offset;
        const y = my + dy * offset;
        const eddy = ctx.createRadialGradient(x, y, 0, x, y, lobe);
        eddy.addColorStop(0, rgb(color, 0.72 * closeness));
        eddy.addColorStop(1, rgb(color, 0));
        ctx.fillStyle = eddy;
        ctx.beginPath();
        ctx.arc(x, y, lobe, 0, Math.PI * 2);
        ctx.fill();
    });
};

const gather = (points) => {
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const a = points[i];
            const b = points[j];
            if (!a.orb.social || !b.orb.social) continue;
            if (a.orb.kind === "bloom" || b.orb.kind === "bloom") continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distance = Math.hypot(dx, dy) || 1;
            const smaller = Math.min(a.radius, b.radius);
            const gap = distance - a.radius - b.radius;
            const reach = smaller * 0.9;
            if (gap > reach) continue;
            const pull = ease(clamp(1 - gap / reach, 0, 1)) * 0.05;
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
    if (loopOn || !showPhoto || !sourceImage) return { blur: 1, grain: 1, photo: 0, orbs: 1 };
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
            const reach = smaller * 1.35;
            if (gap < reach) swell = Math.max(swell, ease(clamp(1 - gap / reach, 0, 1)));
        });
        return swell;
    });
    points.forEach((point, index) => {
        point.radius *= 1 + swellOf[index] * 0.22;
    });
    points.sort((a, b) => order[a.orb.kind] - order[b.orb.kind]);
    linkLayer(width, height);
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) drawMerge(points[i], points[j]);
    }
    if (linkDrawn) {
        ctx.filter = "blur(10px)";
        ctx.drawImage(linkCanvas, 0, 0);
        ctx.filter = "none";
    }

    const meltOf = (point) => {
        let melt = 0;
        points.forEach((other) => {
            if (other === point || other.orb.kind === "bloom") return;
            const distance = Math.hypot(other.x - point.x, other.y - point.y);
            const smaller = Math.min(point.radius, other.radius);
            const gap = distance - point.radius - other.radius;
            const reach = smaller * 1.7;
            if (gap < reach) melt = Math.max(melt, ease(clamp(1 - gap / reach, 0, 1)));
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

const openPicker = (input) => {
    try {
        if (typeof input.showPicker === "function") {
            input.showPicker();
            return;
        }
    } catch (error) {
        /* Öppna via klick om showPicker inte tillåts. */
    }
    input.click();
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

const parseHex = (value, allowShort) => {
    const raw = value.trim().replace(/^#/, "");
    if (/^[\da-f]{6}$/i.test(raw)) return colorOf(`#${raw}`);
    if (allowShort && /^[\da-f]{3}$/i.test(raw)) {
        return colorOf(`#${raw.replace(/./g, (part) => part + part)}`);
    }
    return null;
};

const repaintScene = () => {
    scene = buildScene(activePalette(), sceneSeed);
    applyBackground();
};

const markHex = () => {
    swatches.querySelectorAll(".dot").forEach((dot, index) => {
        dot.dataset.edit = index === hexIndex ? "true" : "false";
    });
};

const showHex = () => {
    if (!analysis || document.activeElement === hexInput) return;
    const color = analysis.colors[hexIndex];
    if (color) hexInput.value = hexOf(color);
    markHex();
};

const applySwatchHex = (value, allowShort) => {
    if (recording || !analysis) return false;
    const color = parseHex(value, allowShort);
    if (!color) return false;
    analysis.colors[hexIndex] = color;
    const dot = swatches.querySelectorAll(".dot")[hexIndex];
    const chip = dot && dot.querySelector(".swatch-chip");
    const picker = dot && dot.querySelector(".picker");
    const hex = hexOf(color);
    if (chip) chip.style.background = hex;
    if (picker) picker.value = hex;
    if (selected[hexIndex]) analysis.accent = color;
    repaintScene();
    return true;
};

const renderSwatches = () => {
    if (hexIndex >= analysis.colors.length) hexIndex = 0;
    swatches.replaceChildren();
    analysis.colors.forEach((color, index) => {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.dataset.on = selected[index] ? "true" : "false";
        dot.dataset.edit = index === hexIndex ? "true" : "false";

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
            markCount();
            repaintScene();
        });

        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "swatch-chip";
        chip.style.background = hexOf(color);
        chip.setAttribute("aria-label", "Ändra färg");

        const input = document.createElement("input");
        input.type = "color";
        input.className = "picker";
        input.value = hexOf(color);
        input.tabIndex = -1;

        const applyColor = () => {
            if (recording) return;
            analysis.colors[index] = colorOf(input.value);
            chip.style.background = input.value;
            if (selected[index]) analysis.accent = analysis.colors[index];
            if (hexIndex === index) hexInput.value = input.value;
            repaintScene();
        };
        let openOnClick = false;
        chip.addEventListener("pointerdown", () => {
            openOnClick = hexIndex === index && document.activeElement === hexInput;
        });
        chip.addEventListener("click", (event) => {
            event.stopPropagation();
            if (recording) return;
            hexIndex = index;
            markHex();
            hexInput.value = hexOf(analysis.colors[index]);
            hexInput.focus();
            hexInput.select();
            if (openOnClick) openPicker(input);
            openOnClick = false;
        });
        input.addEventListener("input", applyColor);
        input.addEventListener("change", applyColor);

        dot.append(hide, chip, input);
        swatches.append(dot);
    });
    showHex();
};

const markCount = () => {
    const count = selected.filter(Boolean).length;
    counts.querySelectorAll("button").forEach((button) => {
        button.setAttribute("aria-pressed", Number(button.dataset.count) === count ? "true" : "false");
    });
};

const renderCounts = () => {
    counts.replaceChildren();
    analysis.colors.forEach((_, index) => {
        const count = index + 1;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.count = String(count);
        button.textContent = String(count);
        button.addEventListener("click", () => {
            if (recording) return;
            applyCount(count);
        });
        counts.append(button);
    });
    markCount();
};

const paintGround = () => {
    const hex = hexOf(analysis.bg);
    groundInput.value = hex;
    groundChip.style.background = hex;
    if (document.activeElement !== groundHex) groundHex.value = hex;
};

const applyGroundHex = (value, allowShort) => {
    if (recording || !analysis) return false;
    const color = parseHex(value, allowShort);
    if (!color) return false;
    analysis.bg = color;
    groundInput.value = hexOf(color);
    groundChip.style.background = hexOf(color);
    repaintScene();
    return true;
};

const applyCount = (count) => {
    selected = analysis.colors.map((_, index) => index < count);
    markCount();
    swatches.querySelectorAll(".dot").forEach((dot, index) => {
        const on = Boolean(selected[index]);
        dot.dataset.on = on ? "true" : "false";
        const hide = dot.querySelector(".dot-hide");
        if (!hide) return;
        hide.setAttribute("aria-pressed", on ? "true" : "false");
        hide.setAttribute("aria-label", on ? "Dölj färgen" : "Visa färgen");
    });
    repaintScene();
};

const setBusy = (busy) => {
    generateButton.disabled = busy || !scene;
    stillButton.disabled = busy || !scene;
    lengthButtons.forEach((button) => {
        button.disabled = busy;
    });
    formatButtons.forEach((button) => {
        button.disabled = busy;
    });
    swatches.querySelectorAll("button, input").forEach((control) => {
        control.disabled = busy;
    });
    counts.querySelectorAll("button").forEach((button) => {
        button.disabled = busy;
    });
    tempoButtons.forEach((button) => {
        button.disabled = busy;
    });
    groundChip.disabled = busy;
    groundOpen.disabled = busy;
    hexInput.disabled = busy;
    groundHex.disabled = busy;
    photoButton.disabled = busy;
    loopButton.disabled = busy;
};

const preview = (now) => {
    if (recording) return;
    if (!lastFrame) lastFrame = now;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    animTime += dt * (loopOn ? 1 : tempo);
    clockTime += dt;
    paint(loopOn ? animTime % loopCycle() : animTime, clockTime, 0);
    raf = requestAnimationFrame(preview);
};

const showScene = (next, message) => {
    scene = next;
    applyBackground();
    canvas.hidden = false;
    empty.hidden = true;
    params.hidden = false;
    generateButton.disabled = false;
    stillButton.disabled = false;
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
    paintGround();
    renderCounts();
    renderSwatches();
    showScene(buildScene(activePalette(), sceneSeed), "");
};

const FORMAT_TYPES = {
    webm: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
    mp4: [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1.4D401E,mp4a.40.2",
        "video/mp4;codecs=avc3.42E01E,mp4a.40.2",
        "video/mp4"
    ]
};

const mimeType = () => {
    const types = FORMAT_TYPES[format] || FORMAT_TYPES.webm;
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
};

const startAmbience = (audioCtx, destination, live = true) => {
    const master = audioCtx.createGain();
    if (loopOn) {
        master.gain.setValueAtTime(0.11, audioCtx.currentTime);
    } else {
        master.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        master.gain.linearRampToValueAtTime(0.11, audioCtx.currentTime + 1.1);
        master.gain.setValueAtTime(0.11, audioCtx.currentTime + Math.max(1.2, duration - 1.3));
        master.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    }
    master.connect(destination);
    if (live && destination !== audioCtx.destination) master.connect(audioCtx.destination);

    const brightness = (scene.bg.r + scene.bg.g + scene.bg.b) / (255 * 3);
    const base = 146 + brightness * 40;
    const nodes = [0, 4, 7].map((semi, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        osc.type = index === 2 ? "triangle" : "sine";
        const tone = base * (2 ** (semi / 12));
        osc.frequency.value = loopOn ? Math.max(1, Math.round(tone * loopCycle())) / loopCycle() : tone;
        osc.detune.value = (index - 1) * 7;
        gain.gain.value = index === 0 ? 0.55 : 0.18;
        filter.type = "lowpass";
        filter.frequency.value = 520;
        const drift = 0.04 + index * 0.025;
        lfo.frequency.value = loopOn ? Math.max(1, Math.round(drift * loopCycle())) / loopCycle() : drift;
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

    const noiseSeconds = loopOn ? loopCycle() : 2;
    const noiseBuffer = audioCtx.createBuffer(1, Math.ceil(audioCtx.sampleRate * noiseSeconds), audioCtx.sampleRate);
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

const mp4Config = async () => {
    if (!window.Mp4Muxer || typeof VideoEncoder === "undefined") return null;
    const videoOptions = {
        width: WIDTH,
        height: HEIGHT,
        bitrate: videoBitrate(),
        bitrateMode: "variable",
        framerate: FPS,
        latencyMode: "quality"
    };
    const videoCodecs = ["avc1.420028", "avc1.4d0028", "avc1.42E01E"];
    const attempts = [videoOptions, { ...videoOptions, latencyMode: "realtime" }];
    let video = null;
    for (const options of attempts) {
        for (const codec of videoCodecs) {
            const withAvc = { ...options, codec, avc: { format: "avc" } };
            const plain = { ...options, codec };
            const supported = await VideoEncoder.isConfigSupported(withAvc);
            if (supported.supported) {
                video = withAvc;
                break;
            }
            const fallback = await VideoEncoder.isConfigSupported(plain);
            if (fallback.supported) {
                video = plain;
                break;
            }
        }
        if (video) break;
    }
    if (!video) return null;
    let audio = null;
    if (typeof AudioEncoder !== "undefined") {
        const candidate = { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 };
        const supported = await AudioEncoder.isConfigSupported(candidate);
        if (supported.supported) audio = candidate;
    }
    return { video, audio };
};

/* Varje bild får sin egen tid, så filen inte står still i början. */
const encodeMp4 = async () => {
    const config = await mp4Config();
    if (!config) return false;

    const cycle = loopCycle();
    const repeats = loopOn ? Math.max(1, Math.round(duration / cycle)) : 1;
    const frameCount = Math.round((repeats > 1 ? cycle : duration) * FPS);
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
        target,
        video: { codec: "avc", width: WIDTH, height: HEIGHT, frameRate: FPS },
        audio: config.audio
            ? { codec: "aac", numberOfChannels: 2, sampleRate: config.audio.sampleRate }
            : undefined,
        firstTimestampBehavior: "offset",
        fastStart: "in-memory"
    });

    let failed = null;
    const chunkBytes = (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        return data;
    };
    const encodedVideo = repeats > 1 ? [] : null;
    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
            const data = chunkBytes(chunk);
            const timestamp = chunk.timestamp;
            const span = chunk.duration ?? Math.round(1e6 / FPS);
            if (encodedVideo) encodedVideo.push({ data, type: chunk.type, timestamp, duration: span, meta });
            else muxer.addVideoChunkRaw(data, chunk.type, timestamp, span, meta);
        },
        error: (error) => {
            failed = error;
        }
    });
    videoEncoder.configure(config.video);

    let audioEncoder = null;
    if (config.audio) {
        const packetSpan = Math.round(1024 * 1e6 / config.audio.sampleRate);
        audioEncoder = new AudioEncoder({
            output: (chunk, meta) => {
                if (chunk.timestamp >= duration * 1e6) return;
                muxer.addAudioChunkRaw(
                    chunkBytes(chunk),
                    chunk.type,
                    chunk.timestamp,
                    chunk.duration ?? packetSpan,
                    meta
                );
            },
            error: (error) => {
                failed = error;
            }
        });
        audioEncoder.configure(config.audio);
        const cycleSamples = Math.round(config.audio.sampleRate * (repeats > 1 ? cycle : duration));
        const offline = new OfflineAudioContext(2, cycleSamples, config.audio.sampleRate);
        startAmbience(offline, offline.destination, false);
        const rendered = await offline.startRendering();
        const left = rendered.getChannelData(0);
        const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
        const packet = 1024;
        const totalSamples = cycleSamples * (repeats > 1 ? repeats : 1);
        for (let offset = 0; offset < totalSamples; offset += packet) {
            const count = Math.min(packet, totalSamples - offset);
            const planar = new Float32Array(packet * 2);
            for (let i = 0; i < count; i++) {
                const source = (offset + i) % left.length;
                planar[i] = left[source];
                planar[packet + i] = right[source];
            }
            const sample = new AudioData({
                format: "f32-planar",
                sampleRate: config.audio.sampleRate,
                numberOfFrames: packet,
                numberOfChannels: 2,
                timestamp: Math.round(offset * 1e6 / config.audio.sampleRate),
                data: planar
            });
            audioEncoder.encode(sample);
            sample.close();
        }
        await audioEncoder.flush();
        audioEncoder.close();
    }

    for (let i = 0; i < frameCount; i++) {
        if (failed) throw failed;
        const clock = i / FPS;
        const motionTime = loopOn ? clock : clock * tempo;
        const fadeOut = loopOn || clock <= duration - 0.8 ? 0 : (clock - (duration - 0.8)) / 0.8;
        paint(motionTime, clock, clamp(fadeOut, 0, 1));
        const timestamp = Math.round(i * 1e6 / FPS);
        const frame = new VideoFrame(canvas, {
            timestamp,
            duration: Math.round((i + 1) * 1e6 / FPS) - timestamp
        });
        videoEncoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        const shown = repeats > 1 ? clock : Math.min(duration, (i + 1) / FPS);
        status.textContent = `Spelar in ${lengthText(shown)} / ${lengthText(duration)}`;
        if (videoEncoder.encodeQueueSize > 4) {
            await new Promise((resolve) => videoEncoder.addEventListener("dequeue", resolve, { once: true }));
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    await videoEncoder.flush();
    videoEncoder.close();
    if (encodedVideo) {
        encodedVideo.sort((a, b) => a.timestamp - b.timestamp);
        const shift = Math.round(cycle * 1e6);
        for (let repeat = 0; repeat < repeats; repeat++) {
            encodedVideo.forEach((sample, index) => {
                muxer.addVideoChunkRaw(
                    sample.data,
                    sample.type,
                    sample.timestamp + repeat * shift,
                    sample.duration,
                    repeat === 0 && index === 0 ? sample.meta : undefined
                );
            });
        }
    }
    if (failed) throw failed;
    muxer.finalize();

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    downloadUrl = URL.createObjectURL(blob);
    downloadLink.href = downloadUrl;
    downloadLink.download = loopOn ? "wsk-loop.mp4" : "wsk-klipp.mp4";
    downloadLink.hidden = false;
    recording = false;
    setBusy(false);
    status.textContent = loopOn ? "Loop klar." : "Klipp klart.";
    animTime = 0;
    lastFrame = 0;
    raf = requestAnimationFrame(preview);
    return true;
};

const recordClip = async () => {
    if (!scene || recording) return;
    const type = mimeType();
    const directMp4 = format === "mp4" && await mp4Config();
    if (!directMp4 && (!type || !canvas.captureStream)) {
        status.textContent = format === "mp4"
            ? "Den här webbläsaren kan inte spara mp4."
            : "Den här webbläsaren kan inte spara klippet.";
        return;
    }

    recording = true;
    setBusy(true);
    downloadLink.hidden = true;
    cancelAnimationFrame(raf);

    sceneSeed = (Math.random() * 1e9) | 0;
    scene = buildScene(activePalette(), sceneSeed);

    if (directMp4) {
        const wrote = await encodeMp4();
        if (wrote) return;
    }

    const audioCtx = new AudioContext();
    await audioCtx.resume();
    const audioDest = audioCtx.createMediaStreamDestination();
    const stopAudio = startAmbience(audioCtx, audioDest);

    const stream = new MediaStream([
        ...canvas.captureStream(FPS).getVideoTracks(),
        ...audioDest.stream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: videoBitrate() });
    const chunks = [];
    recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
    };

    const extension = format === "mp4" ? "mp4" : "webm";
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
        const shown = loopOn ? Math.min(time, Math.max(0, duration - 1 / FPS)) : clipTime;
        const fadeOut = loopOn || time <= duration - 0.8 ? 0 : (time - (duration - 0.8)) / 0.8;
        paint(shown, time, clamp(fadeOut, 0, 1));
        status.textContent = `Spelar in ${lengthText(Math.min(duration, time))} / ${lengthText(duration)}`;
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
    if (loopOn) paint(Math.max(0, duration - 1 / FPS), duration, 0);
    else paint(clipTime, duration, 1);
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    stopAudio();
    await audioCtx.close();

    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    const blob = new Blob(chunks, { type: type });
    downloadUrl = URL.createObjectURL(blob);
    downloadLink.href = downloadUrl;
    downloadLink.download = loopOn ? `wsk-loop.${extension}` : `wsk-klipp.${extension}`;
    downloadLink.hidden = false;

    recording = false;
    setBusy(false);
    status.textContent = loopOn ? "Loop klar." : "Klipp klart.";
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

formatButtons.forEach((button) => {
    button.addEventListener("click", () => {
        if (recording) return;
        format = button.dataset.format;
        formatButtons.forEach((item) => {
            item.setAttribute("aria-pressed", item === button ? "true" : "false");
        });
    });
});

tempoButtons.forEach((button) => {
    button.addEventListener("click", () => {
        if (recording) return;
        tempo = Number(button.dataset.tempo);
        tempoButtons.forEach((item) => {
            item.setAttribute("aria-pressed", item === button ? "true" : "false");
        });
    });
});

const chooseGround = () => {
    if (recording || !analysis) return;
    openPicker(groundInput);
};

let openGroundOnClick = false;
groundChip.addEventListener("pointerdown", () => {
    openGroundOnClick = document.activeElement === groundHex;
});
groundChip.addEventListener("click", () => {
    if (recording || !analysis) return;
    groundHex.value = hexOf(analysis.bg);
    groundHex.focus();
    groundHex.select();
    if (openGroundOnClick) chooseGround();
    openGroundOnClick = false;
});
groundOpen.addEventListener("click", chooseGround);

const bindHex = (input, apply) => {
    input.addEventListener("input", () => {
        apply(input.value, false);
    });
    input.addEventListener("change", () => {
        if (!apply(input.value, true) && analysis) {
            input.value = input === groundHex ? hexOf(analysis.bg) : hexOf(analysis.colors[hexIndex]);
        } else if (analysis) {
            input.value = input === groundHex ? hexOf(analysis.bg) : hexOf(analysis.colors[hexIndex]);
        }
    });
    input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        input.blur();
    });
};

bindHex(hexInput, applySwatchHex);
bindHex(groundHex, applyGroundHex);

groundInput.addEventListener("input", () => {
    if (recording || !analysis) return;
    analysis.bg = colorOf(groundInput.value);
    groundChip.style.background = groundInput.value;
    groundHex.value = groundInput.value;
    repaintScene();
});

loopButton.addEventListener("click", () => {
    if (recording) return;
    loopOn = !loopOn;
    loopButton.setAttribute("aria-pressed", loopOn ? "true" : "false");
    if (loopOn) {
        animTime = 0;
        lastFrame = 0;
    }
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

stillButton.addEventListener("click", () => {
    if (!scene || recording) return;
    stillCount += 1;
    const number = stillCount;
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `wsk-bild-${number}.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        status.textContent = "Bild sparad.";
    }, "image/png");
});

generateButton.addEventListener("click", () => {
    recordClip().catch(() => {
        recording = false;
        setBusy(false);
        status.textContent = "Inspelningen avbröts.";
        cancelAnimationFrame(raf);
        lastFrame = 0;
        raf = requestAnimationFrame(preview);
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
