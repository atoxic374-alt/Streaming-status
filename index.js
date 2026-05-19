// เอาไปแจกต่อให้เครดิตด้วย | By 4levy ใครเปลี่ยนขอให้ไม่เจอดี
require('dotenv').config();

const { Client, RichPresence, CustomStatus, SpotifyRPC, Options } = require("discord.js-selfbot-v13");
const moment = require("moment-timezone");
const { schedule } = require("node-cron");
const os = require("os");
require("colors");

class GetImage {
    constructor(client) {
        this.client = client;
    }

    isValidURL(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    async get(url1, url2) {
        try {
            url1 = this.isValidURL(url1) ? url1 : null;
            url2 = this.isValidURL(url2) ? url2 : null;
            if (!url1 && !url2) {
                throw new Error("No Image");
            }

            const { getExternal } = RichPresence;
            const images = await getExternal(this.client, "1109522937989562409", url1, url2);

            if (images.length === 1) {
                const { url, external_asset_path } = images[0];
                if (url === url1) {
                    url1 = url.includes("attachments") ? url : external_asset_path;
                    url2 = null;
                } else if (url === url2) {
                    url1 = null;
                    url2 = url.includes("attachments") ? url : external_asset_path;
                }
            } else if (images.length === 2) {
                const [img1, img2] = images;
                if (img1.external_asset_path) {
                    const { url, external_asset_path } = img1;
                    url1 = url.includes("attachments") ? url : external_asset_path;
                }
                if (img2.external_asset_path) {
                    const { url, external_asset_path } = img2;
                    url2 = url.includes("attachments") ? url : external_asset_path;
                }
            } else {
                throw new Error("No Image");
            }

            return { bigImage: url1, smallImage: url2 };
        } catch {
            return { bigImage: null, smallImage: null };
        }
    }
}

class Weather {
    constructor(location) {
        this.location = location;
        this.feelslike_c = 0;
        this.feelslike_f = 0;
        this.windchill_c = 0;
        this.windchill_f = 0;
        this.heatindex_c = 0;
        this.heatindex_f = 0;
        this.dewpoint_c = 0;
        this.dewpoint_f = 0;
        this.co = 0;
        this.no2 = 0;
        this.o3 = 0;
        this.so2 = 0;
        this.pm10 = 0;
        this.stop = 0;
        schedule("*/5 * * * *", () => this.update());
    }

    async update() {
        try {
            const params = new URLSearchParams();
            params.append("key", process.env.WEATHER_API_KEY || "1e1a0f498dbf472cb3991045241608");
            params.append('q', encodeURIComponent(this.location));
            params.append("aqi", "yes");

            const response = await fetch(`https://api.weatherapi.com/v1/current.json?${params}`);
            const data = await response.json();

            this.timezone = data.location.tz_id;
            this.city = data.location.name;
            this.region = data.location.region;
            this.country = data.location.country;
            this.temp_c = data.current.temp_c;
            this.temp_f = data.current.temp_f;
            this.wind_kph = data.current.wind_kph;
            this.wind_mph = data.current.wind_mph;
            this.wind_degree = data.current.wind_degree;
            this.pressure_mb = data.current.pressure_mb;
            this.pressure_in = data.current.pressure_in;
            this.precip_mm = data.current.precip_mm;
            this.precip_in = data.current.precip_in;
            this.wind_dir = data.current.wind_dir;
            this.gust_kph = data.current.gust_kph;
            this.gust_mph = data.current.gust_mph;
            this.vis_km = data.current.vis_km;
            this.vis_mi = data.current.vis_miles;
            this.humidity = data.current.humidity;
            this.cloud = data.current.cloud;
            this.uv = data.current.uv;
            this.pm2_5 = data.current.air_quality.pm2_5;
            this.feelslike_c = data.current.feelslike_c;
            this.feelslike_f = data.current.feelslike_f;
            this.windchill_c = data.current.windchill_c;
            this.windchill_f = data.current.windchill_f;
            this.heatindex_c = data.current.heatindex_c;
            this.heatindex_f = data.current.heatindex_f;
            this.dewpoint_c = data.current.dewpoint_c;
            this.dewpoint_f = data.current.dewpoint_f;
            this.co = data.current.air_quality.co;
            this.no2 = data.current.air_quality.no2;
            this.o3 = data.current.air_quality.o3;
            this.so2 = data.current.air_quality.so2;
            this.pm10 = data.current.air_quality.pm10;
        } catch {
            if (this.stop > 10) {
                return;
            }
            this.stop++;
            this.update();
        }
    }
}

class SystemInfo {
    constructor() {
        this.cpuname = os.cpus()[0]?.model;
        this.cpucores = os.cpus()?.length;
        this.cpuspeed = (os.cpus()[0]?.speed / 1000 || 0).toFixed(1);
        this.cpu = 0;
        this.ram = 0;
    }

    getCpuUsage() {
        let totalIdle = 0, totalTick = 0;
        const cpus = os.cpus();

        cpus.forEach(cpu => {
            for (let type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });

        return 100 - Math.floor(totalIdle / totalTick * 100);
    }

    async getCpuUsageOverInterval(interval) {
        return new Promise(resolve => {
            const startMeasure = this._measureCpuTimes();
            setTimeout(() => {
                const endMeasure = this._measureCpuTimes();
                const idleDifference = endMeasure.idle - startMeasure.idle;
                const totalDifference = endMeasure.total - startMeasure.total;
                resolve(100 - Math.floor(idleDifference / totalDifference * 100));
            }, interval);
        });
    }

    _measureCpuTimes() {
        let totalIdle = 0, totalTick = 0;
        const cpus = os.cpus();

        cpus.forEach(cpu => {
            for (let type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });

        return { idle: totalIdle, total: totalTick };
    }

    getRamUsage() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        return Math.floor((totalMem - freeMem) / totalMem * 100);
    }

    async update() {
        this.cpu = await this.getCpuUsageOverInterval(1000);
        this.ram = this.getRamUsage();
    }
}

class Emoji {
    random() {
        const emojis = ['😄', '😃', '😀', '😊', '☺', '😉', '😍', '😘', '😚', '😗', '😙', '😜', '😝', '😛', '😳', '😁', '😔', '😌', '😒', '😞', '😣', '😢', '😂', '😭', '😪', '😥', '😰', '😅', '😓', '😩', '😫', '😨', '😱', '😠', '😡', '😤', '😖', '😆', '😋', '😷', '😎', '😴', '😵', '😲', '😟', '😦', '😧', '😈', '👿', '😮', '😬', '😐', '😕', '😯', '😶', '😇', '😏', '😑', '👲', '👳', '👮', '👷', '💂', '👶', '👦', '👧', '👨', '👩', '👴', '👵', '👱', '👼', '👸', '😺', '😸', '😻', '😽', '😼', '🙀', '😿', '😹', '😾', '👹', '👺', '🙈', '🙉', '🙊', '💀', '👽', '💩', '🔥', '✨', '🌟', '💫', '💥', '💢', '💦', '💧', '💤', '💨', '👂', '👀', '👃', '👅', '👄', '👍', '👎', '👌', '👊', '✊', '✌', '👋', '✋', '👐', '👆', '👇', '👉', '👈', '🙌', '🙏', '☝', '👏', '💪', '🚶', '🏃', '💃', '👫', '👪', '👬', '👭', '💏', '💑', '👯', '🙆', '🙅', '💁', '🙋', '💆', '💇', '💅', '👰', '🙎', '🙍', '🙇', '🎩', '👑', '👒', '👟', '👞', '👡', '👠', '👢', '👕', '👔', '👚', '👗', '🎽', '👖', '👘', '👙', '💼', '👜', '👝', '👛', '👓', '🎀', '🌂', '💄', '💛', '💙', '💜', '💚', '❤', '💔', '💗', '💓', '💕', '💖', '💞', '💘', '💌', '💋', '💍', '💎', '👤', '👥', '💬', '👣', '💭', '🐶', '🐺', '🐱', '🐭', '🐹', '🐰', '🐸', '🐯', '🐨', '🐻', '🐷', '🐽', '🐮', '🐗', '🐵', '🐒', '🐴', '🐑', '🐘', '🐼', '🐧', '🐦', '🐤', '🐥', '🐣', '🐔', '🐍', '🐢', '🐛', '🐝', '🐜', '🐞', '🐌', '🐙', '🐚', '🐠', '🐟', '🐬', '🐳', '🐋', '🐄', '🐏', '🐀', '🐃', '🐅', '🐇', '🐉', '🐎', '🐐', '🐓', '🐕', '🐖', '🐁', '🐂', '🐲', '🐡', '🐊', '🐫', '🐪', '🐆', '🐈', '🐩', '🐾', '💐', '🌸', '🌷', '🍀', '🌹', '🌻', '🌺', '🍁', '🍃', '🍂', '🌿', '🌾', '🍄', '🌵', '🌴', '🌲', '🌳', '🌰', '🌱', '🌼', '🌐', '🌞', '🌝', '🌚', '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌜', '🌛', '🌙', '🌍', '🌎', '🌏', '🌋', '🌌', '🌠', '⭐', '☀', '⛅', '☁', '⚡', '☔', '❄', '⛄', '🌀', '🌁', '🌈', '🌊', '🎍', '💝', '🎎', '🎒', '🎓', '🎏', '🎆', '🎇', '🎐', '🎑', '🎃', '👻', '🎅', '🎄', '🎁', '🎋', '🎉', '🎊', '🎈', '🎌', '🔮', '🎥', '📷', '📹', '📼', '💿', '📀', '💽', '💾', '💻', '📱', '☎', '📞', '📟', '📠', '📡', '📺', '📻', '🔊', '🔉', '🔈', '🔇', '🔔', '🔕', '📢', '📣', '⏳', '⌛', '⏰', '⌚', '🔓', '🔒', '🔏', '🔐', '🔑', '🔎', '💡', '🔦', '🔆', '🔅', '🔌', '🔋', '🔍', '🛁', '🛀', '🚿', '🚽', '🔧', '🔩', '🔨', '🚪', '🚬', '💣', '🔫', '🔪', '💊', '💉', '💰', '💴', '💵', '💷', '💶', '💳', '💸', '📲', '📧', '📥', '📤', '✉', '📩', '📨', '📯', '📫', '📪', '📬', '📭', '📮', '📦', '📝', '📄', '📃', '📑', '📊', '📈', '📉', '📜', '📋', '📅', '📆', '📇', '📁', '📂', '✂', '📌', '📎', '✒', '✏', '📏', '📐', '📕', '📗', '📘', '📙', '📓', '📔', '📒', '📚', '📖', '🔖', '📛', '🔬', '🔭', '📰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎵', '🎶', '🎹', '🎻', '🎺', '🎷', '🎸', '👾', '🎮', '🃏', '🎴', '🀄', '🎲', '🎯', '🏈', '🏀', '⚽', '⚾', '🎾', '🎱', '🏉', '🎳', '⛳', '🚵', '🚴', '🏁', '🏇', '🏆', '🎿', '🏂', '🏊', '🏄', '🎣', '☕', '🍵', '🍶', '🍼', '🍺', '🍻', '🍸', '🍹', '🍷', '🍴', '🍕', '🍔', '🍟', '🍗', '🍖', '🍝', '🍛', '🍤', '🍱', '🍣', '🍥', '🍙', '🍘', '🍚', '🍜', '🍲', '🍢', '🍡', '🍳', '🍞', '🍩', '🍮', '🍦', '🍨', '🍧', '🎂', '🍰', '🍪', '🍫', '🍬', '🍭', '🍯', '🍎', '🍏', '🍊', '🍋', '🍒', '🍇', '🍉', '🍓', '🍑', '🍈', '🍌', '🍐', '🍍', '🍠', '🍆', '🍅', '🌽', '🏠', '🏡', '🏫', '🏢', '🏣', '🏥', '🏦', '🏪', '🏩', '🏨', '💒', '⛪', '🏬', '🏤', '🌇', '🌆', '🏯', '🏰', '⛺', '🏭', '🗼', '🗾', '🗻', '🌄', '🌅', '🌃', '🗽', '🌉', '🎠', '🎡', '⛲', '🎢', '🚢', '⛵', '🚤', '🚣', '⚓', '🚀', '✈', '💺', '🚁', '🚂', '🚊', '🚉', '🚞', '🚆', '🚄', '🚅', '🚈', '🚇', '🚝', '🚋', '🚃', '🚎', '🚌', '🚍', '🚙', '🚘', '🚗', '🚕', '🚖', '🚛', '🚚', '🚨', '🚓', '🚔', '🚒', '🚑', '🚐', '🚲', '🚡', '🚟', '🚠', '🚜', '💈', '🚏', '🎫', '🚦', '🚥', '⚠', '🚧', '🔰', '⛽', '🏮', '🎰', '♨', '🗿', '🎪', '🎭', '📍', '🚩', '⬆', '⬇', '⬅', '➡', '🔠', '🔡', '🔤', '↗', '↖', '↘', '↙', '↔', '↕', '🔄', '◀', '▶', '🔼', '🔽', '↩', '↪', 'ℹ', '⏪', '⏩', '⏫', '⏬', '⤵', '⤴', '🆗', '🔀', '🔁', '🔂', '🆕', '🆙', '🆒', '🆓', '🆖', '📶', '🎦', '🈁', '🈯', '🈳', '🈵', '🈴', '🈲', '🉐', '🈹', '🈺', '🈶', '🈚', '🚻', '🚹', '🚺', '🚼', '🚾', '🚰', '🚮', '🅿', '♿', '🚭', '🈷', '🈸', '🈂', 'Ⓜ', '🛂', '🛄', '🛅', '🛃', '🉑', '㊙', '㊗', '🆑', '🆘', '🆔', '🚫', '🔞', '📵', '🚯', '🚱', '🚳', '🚷', '🚸', '⛔', '✳', '❇', '❎', '✅', '✴', '💟', '🆚', '📳', '📴', '🅰', '🅱', '🆎', '🅾', '💠', '➿', '♻', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '⛎', '🔯', '🏧', '💹', '💲', '💱', '©', '®', '™', '〽', '〰', '🔝', '🔚', '🔙', '🔛', '🔜', '❌', '⭕', '❗', '❓', '❕', '❔', '🔃', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '✖', '➕', '➖', '➗', '♠', '♥', '♣', '♦', '💮', '💯', '✔', '☑', '🔘', '🔗', '➰', '🔱', '🔲', '🔳', '◼', '◻', '◾', '◽', '▪', '▫', '🔺', '⬜', '⬛', '⚫', '⚪', '🔴', '🔵', '🔻', '🔶', '🔷', '🔸', '🔹'];
        return emojis[Math.floor(Math.random() * emojis.length)];
    }

    getTime(hour) {
        const parsedHour = parseInt(hour, 10);
        return isNaN(parsedHour)
            ? "Invalid hour"
            : parsedHour >= 6 && parsedHour < 18
                ? "☀️"
                : "🌙";
    }

    getClock(hour) {
        const parsedHour = parseInt(hour, 10);
        const clocks = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"];
        return parsedHour >= 0 && parsedHour <= 23
            ? clocks[parsedHour % 12]
            : "Invalid hour";
    }
}

class TextFont {
    getFont1(text) {
        const fontMap = {
            a: "๐", b: "๑", c: "๒", d: "๓", e: "๔", f: "๕", g: "๖",
            h: "๗", i: "๘", j: "๙", k: "๐", l: "๑", m: "๒", n: "๓",
            o: "๔", p: "๕", q: "๖", r: "๗", s: "๘", t: "๙", u: "๐",
            v: "๑", w: "๒", x: "๓", y: "๔", z: "๕",

            A: "๐", B: "๑", C: "๒", D: "๓", E: "๔", F: "๕", G: "๖",
            H: "๗", I: "๘", J: "๙", K: "๐", L: "๑", M: "๒", N: "๓",
            O: "๔", P: "๕", Q: "๖", R: "๗", S: "๘", T: "๙", U: "๐",
            V: "๑", W: "๒", X: "๓", Y: "๔", Z: "๕",

            "0": "๐", "1": "๑", "2": "๒", "3": "๓", "4": "๔",
            "5": "๕", "6": "๖", "7": "๗", "8": "๘", "9": "๙",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }
    getFont2(text) {
        const fontMap = {
            a: "𝕒", b: "𝕓", c: "𝕔", d: "𝕕", e: "𝕖", f: "𝕗", g: "𝕘",
            h: "𝕙", i: "𝕚", j: "𝕛", k: "𝕜", l: "𝕝", m: "𝕞", n: "𝕟",
            o: "𝕠", p: "𝕡", q: "𝕢", r: "𝕣", s: "𝕤", t: "𝕥", u: "𝕦",
            v: "𝕧", w: "𝕨", x: "𝕩", y: "𝕪", z: "𝕫",

            A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾",
            H: "ℍ", I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", N: "ℕ",
            O: "𝕆", P: "ℙ", Q: "ℚ", R: "ℝ", S: "𝕊", T: "𝕋", U: "𝕌",
            V: "𝕍", W: "𝕎", X: "𝕏", Y: "𝕐", Z: "ℤ",

            "0": "𝟘", "1": "𝟙", "2": "𝟚", "3": "𝟛", "4": "𝟜",
            "5": "𝟝", "6": "𝟞", "7": "𝟟", "8": "𝟠", "9": "𝟡",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont3(text) {
        const fontMap = {
            a: "𝗮", b: "𝗯", c: "𝗰", d: "𝗱", e: "𝗲", f: "𝗳", g: "𝗴",
            h: "𝗵", i: "𝗶", j: "𝗷", k: "𝗸", l: "𝗹", m: "𝗺", n: "𝗻",
            o: "𝗼", p: "𝗽", q: "𝗾", r: "𝗿", s: "𝘀", t: "𝘁", u: "𝘂",
            v: "𝘃", w: "𝘄", x: "𝘅", y: "𝘆", z: "𝘇",

            A: "𝗔", B: "𝗕", C: "𝗖", D: "𝗗", E: "𝗘", F: "𝗙", G: "𝗚",
            H: "𝗛", I: "𝗜", J: "𝗝", K: "𝗞", L: "𝗟", M: "𝗠", N: "𝗡",
            O: "𝗢", P: "𝗣", Q: "𝗤", R: "𝗥", S: "𝗦", T: "𝗧", U: "𝗨",
            V: "𝗩", W: "𝗪", X: "𝗫", Y: "𝗬", Z: "𝗭",

            "0": "𝟬", "1": "𝟭", "2": "𝟮", "3": "𝟯", "4": "𝟰",
            "5": "𝟱", "6": "𝟲", "7": "𝟳", "8": "𝟴", "9": "𝟵",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }


    getFont4(text) {
        const fontMap = {
            a: "𝒶", b: "𝒷", c: "𝒸", d: "𝒹", e: "𝑒", f: "𝒻", g: "𝑔",
            h: "𝒽", i: "𝒾", j: "𝒿", k: "𝓀", l: "𝓁", m: "𝓂", n: "𝓃",
            o: "𝑜", p: "𝓅", q: "𝓆", r: "𝓇", s: "𝓈", t: "𝓉", u: "𝓊",
            v: "𝓋", w: "𝓌", x: "𝓍", y: "𝓎", z: "𝓏",

            A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ", G: "𝒢",
            H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ", M: "ℳ", N: "𝒩",
            O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ", S: "𝒮", T: "𝒯", U: "𝒰",
            V: "𝒱", W: "𝒲", X: "𝒳", Y: "𝒴", Z: "𝒵",

            "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
            "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont5(text) {
        const fontMap = {
            a: "𝓪", b: "𝓫", c: "𝓬", d: "𝓭", e: "𝓮", f: "𝓯", g: "𝓰",
            h: "𝓱", i: "𝓲", j: "𝓳", k: "𝓴", l: "𝓵", m: "𝓶", n: "𝓷",
            o: "𝓸", p: "𝓹", q: "𝓺", r: "𝓻", s: "𝓼", t: "𝓽", u: "𝓾",
            v: "𝓿", w: "𝔀", x: "𝔁", y: "𝔂", z: "𝔃",

            A: "𝓐", B: "𝓑", C: "𝓒", D: "𝓓", E: "𝓔", F: "𝓕", G: "𝓖",
            H: "𝓗", I: "𝓘", J: "𝓙", K: "𝓚", L: "𝓛", M: "𝓜", N: "𝓝",
            O: "𝓞", P: "𝓟", Q: "𝓠", R: "𝓡", S: "𝓢", T: "𝓣", U: "𝓤",
            V: "𝓥", W: "𝓦", X: "𝓧", Y: "𝓨", Z: "𝓩",

            "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
            "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont6(text) {
        const fontMap = {
            a: "ⓐ", b: "ⓑ", c: "ⓒ", d: "ⓓ", e: "ⓔ", f: "ⓕ", g: "ⓖ",
            h: "ⓗ", i: "ⓘ", j: "ⓙ", k: "ⓚ", l: "ⓛ", m: "ⓜ", n: "ⓝ",
            o: "ⓞ", p: "ⓟ", q: "ⓠ", r: "ⓡ", s: "ⓢ", t: "ⓣ", u: "ⓤ",
            v: "ⓥ", w: "ⓦ", x: "ⓧ", y: "ⓨ", z: "ⓩ",

            A: "Ⓐ", B: "Ⓑ", C: "Ⓒ", D: "Ⓓ", E: "Ⓔ", F: "Ⓕ", G: "Ⓖ",
            H: "Ⓗ", I: "Ⓘ", J: "Ⓙ", K: "Ⓚ", L: "Ⓛ", M: "Ⓜ", N: "Ⓝ",
            O: "Ⓞ", P: "Ⓟ", Q: "Ⓠ", R: "Ⓡ", S: "Ⓢ", T: "Ⓣ", U: "Ⓤ",
            V: "Ⓥ", W: "Ⓦ", X: "Ⓧ", Y: "Ⓨ", Z: "Ⓩ",

            "0": "⓪", "1": "①", "2": "②", "3": "③", "4": "④",
            "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }
}

class ModClient extends Client {
    constructor(token, config, info) {
        // ── Browser-like WebSocket fingerprint ─────────────────────
        // Makes the connection look like Discord's official web client
        super({
            partials: [],
            makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
            checkUpdate: false,
            readyStatus: false,
            ws: {
                properties: {
                    browser:            'Discord Client',
                    browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9166 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36',
                    browser_version:    '30.2.0',
                    client_build_number: 331958,
                    device:             '',
                    os:                 'Windows',
                    os_version:         '10',
                    release_channel:    'stable',
                    system_locale:      'en-US',
                },
            },
        });

        this.TOKEN = token;
        this.config = config;
        this.targetTime = info.wait;
        this.intervals = new Set();
        this.weather = new Weather(config.setup?.city);
        this.sys = new SystemInfo();
        this.emoji = new Emoji();
        this.textFont = new TextFont();
        this.getExternal = new GetImage(this);
        this.cacheImage = new Map();
        this.lib = { count: 0, countParty: 1, timestamp: 0, v: { patch: info.version } };
        this.index = {
            url: 0, text_0: 0, text_1: 0, text_2: 0,
            text_3: 0, text_4: 0, bm: 0, sm: 0, bt_1: 0, bt_2: 0
        };
        // Track if first streaming call (for startup sequence)
        this._firstPresence = true;
        this._lastPresenceTs = 0;
    }

    // ── Human simulation helpers ────────────────────────────────────

    /**
     * Add random jitter to a delay value.
     * factor 0.25 = ±25% randomness around the base
     */
    jitter(ms, factor) {
        const f = factor ?? (this.config.config?.options?.humanJitter ?? 0.25);
        const variance = ms * f;
        return Math.max(5000, ms - variance + Math.random() * variance * 2);
    }

    /** Async sleep with optional jitter */
    humanSleep(ms, jitterFactor = 0) {
        const delay = jitterFactor > 0 ? this.jitter(ms, jitterFactor) : ms;
        return new Promise(r => setTimeout(r, delay));
    }

    /** Pick random int between min and max */
    rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // ── Streaming presence ──────────────────────────────────────────
    // ── Auto-detect Application ID from Developer Portal ───────────────
    async autoDetectAppId() {
        try {
            const r = await fetch('https://discord.com/api/v10/applications?with_team_applications=true', {
                headers: {
                    'Authorization': this.TOKEN,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9166 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36',
                },
                signal: AbortSignal.timeout(8000)
            });
            if (!r.ok) {
                console.log(`[AppID] API returned ${r.status} — will use fallback`.yellow);
                return null;
            }
            const apps = await r.json();
            if (Array.isArray(apps) && apps.length > 0) {
                const app = apps[0];
                console.log(`[AppID] Auto-detected: "${app.name}" (${app.id})`.cyan);
                return app.id;
            }
            console.log(`[AppID] No applications in Developer Portal — using fallback`.yellow);
        } catch (e) {
            console.log(`[AppID] Auto-detect error: ${e.message} — using fallback`.yellow);
        }
        return null;
    }

    async streaming() {
        const { setup, config } = this.config;
        const opts = config.options || {};

        const humanMode = opts.humanMode !== false; // default ON

        // ── Resolve Application ID ──────────────────────────────────────
        // Priority: config → auto-detect from Developer Portal → hardcoded fallback
        let applicationId = opts.botid?.trim();
        if (!applicationId) {
            if (!this._detectedAppId) {
                this._detectedAppId = await this.autoDetectAppId();
            }
            applicationId = this._detectedAppId || '1109522937989562409';
        }

        // ── Safe minimum delay ──────────────────────────────────────
        // Never update faster than 30 s in human mode (avoids rate detection)
        const configuredDelay = Math.max((setup?.delay || 30) * 1000, humanMode ? 30000 : 8000);

        // ── Resolve streaming URL ───────────────────────────────────
        const urlList = opts["watch-url"] || config["watch-url"] || [];
        let watchUrl = urlList[this.index.url];

        if (!watchUrl || !this.getExternal.isValidURL(watchUrl)) {
            console.log(`[!] No valid streaming URL — retry in 30s`);
            setTimeout(() => this.streaming(), 30000);
            return;
        }

        // ── Platform detection ──────────────────────────────────────
        let platform = 'Twitch';
        if (watchUrl.includes("youtube.com") || watchUrl.includes("youtu.be")) platform = 'YouTube';
        else if (watchUrl.includes("kick.com")) platform = 'Kick';

        // ── Build RichPresence ──────────────────────────────────────
        const presence = new RichPresence(this)
            .setApplicationId(applicationId)
            .setType("STREAMING")
            .setURL(watchUrl)
            .setName(platform);

        const text1 = config["text-1"]?.[this.index.text_1] ?? null;
        if (text1) presence.setDetails(this.SPT(text1));

        const text2 = config["text-2"]?.[this.index.text_2] ?? null;
        if (text2) presence.setState(this.SPT(text2));

        const text3 = config["text-3"]?.[this.index.text_3] ?? null;
        if (text3) presence.setAssetsLargeText(this.SPT(text3));

        if (config["text-4"]?.length) {
            const text4 = config["text-4"][this.index.text_4];
            if (text4) presence.setAssetsSmallText(this.SPT(text4));
        }

        // Images
        if (config.bigimg?.length || config.smallimg?.length) {
            const bigImg  = config.bigimg?.[this.index.bm];
            const smallImg = config.smallimg?.[this.index.sm];
            const images = await this.getImage(bigImg, smallImg);
            if (images.bigImage)  presence.setAssetsLargeImage(images.bigImage);
            if (images.smallImage) presence.setAssetsSmallImage(images.smallImage);
        }

        // Buttons — only add if both name and url are set
        if (config["button-1"]?.[0]?.url) {
            const b = config["button-1"][this.index.bt_1];
            if (b?.name && b?.url) presence.addButton(this.SPT(b.name), b.url);
        }
        if (config["button-2"]?.[0]?.url) {
            const b = config["button-2"][this.index.bt_2];
            if (b?.name && b?.url) presence.addButton(this.SPT(b.name), b.url);
        }

        // ── Build activities array ──────────────────────────────────
        const activities = [presence];

        // Custom Status alongside streaming (if enabled)
        if (config.customStatus?.enabled && config.customStatus?.text) {
            try {
                const cs = new CustomStatus(this);
                cs.setState(this.SPT(config.customStatus.text));
                if (config.customStatus.emoji) cs.setEmoji(config.customStatus.emoji);
                activities.push(cs);
            } catch (e) {
                // CustomStatus not available in this build — skip silently
            }
        }

        // ── Push presence ───────────────────────────────────────────
        this.user?.setPresence({ status: 'online', activities });
        this._lastPresenceTs = Date.now();

        // Emit rotation counters for dashboard stats
        console.log(`[ROT:text1]`);
        if (this.lib.count % 2 === 0) console.log(`[ROT:text2]`);
        if (this.lib.count % 4 === 0) console.log(`[ROT:images]`);

        this.lib.count++;
        this.lib.countParty++;

        // ── Advance rotation indices ────────────────────────────────
        const adv = (cur, arr) => (arr?.length ? (cur + 1) % arr.length : 0);
        this.index.url    = adv(this.index.url,    urlList);
        this.index.text_0 = adv(this.index.text_0, config["text-1"]);
        this.index.text_1 = adv(this.index.text_1, config["text-1"]);
        this.index.text_2 = adv(this.index.text_2, config["text-2"]);
        this.index.text_3 = adv(this.index.text_3, config["text-3"]);
        this.index.text_4 = adv(this.index.text_4, config["text-4"]);
        this.index.bt_1   = adv(this.index.bt_1,   config["button-1"]);
        this.index.bt_2   = adv(this.index.bt_2,   config["button-2"]);
        this.index.bm     = adv(this.index.bm,     config.bigimg);
        this.index.sm     = adv(this.index.sm,     config.smallimg);

        // ── Schedule next cycle ─────────────────────────────────────
        const nextDelay = humanMode ? this.jitter(configuredDelay) : configuredDelay;

        if (humanMode) {
            // ── Occasional idle simulation ──────────────────────────
            // Simulates a human stepping away from keyboard briefly
            const idleChance = opts.idleChance ?? 0.04; // 4% per cycle
            if (Math.random() < idleChance) {
                const idleSec = this.rand(
                    opts.idleMinSec ?? 60,
                    opts.idleMaxSec ?? 240
                );
                console.log(`[Human] Going idle for ${idleSec}s — natural behavior simulation`);
                setTimeout(async () => {
                    try {
                        await this.user?.setStatus('idle');
                        await this.humanSleep(idleSec * 1000, 0.15);
                        await this.user?.setStatus('online');
                        await this.humanSleep(this.rand(3000, 8000));
                    } catch {}
                    this.streaming();
                }, this.rand(2000, 6000));
                return; // skip normal scheduling
            }
        }

        setTimeout(() => this.streaming(), nextDelay);
    }

    startInterval(callback, interval) {
        const id = setInterval(callback, interval);
        this.intervals.add(id);
        return id;
    }

    stopAllIntervals() {
        for (let id of this.intervals) clearInterval(id);
        this.intervals.clear();
    }

    maskToken(token) {
        const parts = token.split('.');
        if (parts.length < 2) return token;
        return `${parts[0]}.##########`;
    }

    async getImage(bigImg, smallImg) {
        const [bigImage, smallImage] = await Promise.all([this.SPT(bigImg), this.SPT(smallImg)]);
        const images = await this.getExternal.get(bigImage, smallImage);
        const finalBigImage = images.bigImage ?? this.cacheImage.get(bigImg);
        const finalSmallImage = images.smallImage ?? this.cacheImage.get(smallImg);

        if (images.bigImage) this.cacheImage.set(bigImg, images.bigImage);
        if (images.smallImage) this.cacheImage.set(smallImg, images.smallImage);

        return { bigImage: finalBigImage, smallImage: finalSmallImage };
    }

    replaceVariables(text, variables) {
        const map = new Map(Object.entries(variables));
        return text.replace(/\{([^{}]+)\}/g, (match, key) => {
            const funcMatch = key.match(/^(\w+)\((.+)\)$/);
            if (funcMatch) {
                const [, funcName, args] = funcMatch;
                const func = map.get(funcName);
                if (typeof func === "function") {
                    return func(args.trim());
                }
            }
            const [varName, defaultValue] = key.split('=');
            if (defaultValue) {
                const [funcName, ...params] = defaultValue.split(':');
                const func = map.get(`${varName}=${funcName}`);
                if (typeof func === "function") {
                    return func(match, ...params);
                }
            }
            return map.has(key) ? map.get(key) : match;
        });
    }

    SPT(text) {
        if (!text) return text || null;
    
        const { weather, sys, emoji, textFont, lib } = this;
        const currentMoment = moment().locale('th').tz(weather.timezone);
    
        const variables = {
            // Time
            'hour:1': currentMoment.format('HH'),
            'hour:2': currentMoment.format('hh'),
            'min:1': currentMoment.format('mm'),
            'min:2': currentMoment.format('mm A'),
    
            // Thai Date
            'th=date': currentMoment.format('D'),
            'th=week:1': currentMoment.format('ddd'),
            'th=week:2': currentMoment.format('dddd'),
            'th=month:1': currentMoment.format('M'),
            'th=month:2': currentMoment.format('MMM'),
            'th=month:3': currentMoment.format('MMMM'),
            'th=year:1': (parseInt(currentMoment.format('YYYY')) + 543).toString().slice(-2),
            'th=year:2': (parseInt(currentMoment.format('YYYY')) + 543).toString(),
    
            // English Date
            'en=date': currentMoment.locale('en').format('Do'),
            'en=week:1': currentMoment.locale('en').format('ddd'),
            'en=week:2': currentMoment.locale('en').format('dddd'),
            'en=month:1': currentMoment.locale('en').format('M'),
            'en=month:2': currentMoment.locale('en').format('MMM'),
            'en=month:3': currentMoment.locale('en').format('MMMM'),
            'en=year:1': currentMoment.locale('en').format('YY'),
            'en=year:2': currentMoment.locale('en').format('YYYY'),
    
            // Weather
            'city': weather.city,
            'region': weather.region,
            'country': weather.country,
            'temp:c': weather.temp_c,
            'temp:f': weather.temp_f,
            'wind:kph': weather.wind_kph,
            'wind:mph': weather.wind_mph,
            'wind:degree': weather.wind_degree,
            'wind:dir': weather.wind_dir,
            'pressure:mb': weather.pressure_mb,
            'pressure:in': weather.pressure_in,
            'precip:mm': weather.precip_mm,
            'precip:in': weather.precip_in,
            'gust:kph': weather.gust_kph,
            'gust:mph': weather.gust_mph,
            'feelslike:c': weather.feelslike_c,
            'feelslike:f': weather.feelslike_f,
            'windchill:c': weather.windchill_c,
            'windchill:f': weather.windchill_f,
            'heatindex:c': weather.heatindex_c,
            'heatindex:f': weather.heatindex_f,
            'dewpoint:c': weather.dewpoint_c,
            'dewpoint:f': weather.dewpoint_f,
            'vis:km': weather.vis_km,
            'vis:mi': weather.vis_miles,
            'humidity': weather.humidity,
            'cloud': weather.cloud,
            'uv': weather.uv,
            'co': weather.co,
            'no2': weather.no2,
            'o3': weather.o3,
            'so2': weather.so2,
            'pm2.5': weather.pm2_5,
            'pm10': weather.pm10,
    
            // System
            'ping': Math.round(this.ws.ping),
            'patch': lib.v.patch,
            'cpu:name': sys.cpuname,
            'cpu:cores': sys.cpucores,
            'cpu:speed': sys.cpuspeed,
            'cpu:usage': sys.cpu,
            'ram:usage': sys.ram,
            'uptime:days': Math.trunc(this.uptime / 86400000),
            'uptime:hours': Math.trunc(this.uptime / 3600000 % 24),
            'uptime:minutes': Math.trunc(this.uptime / 60000 % 60),
            'uptime:seconds': Math.trunc(this.uptime / 1000 % 60),
    
            // User
            'user:name': this.user?.username,
            'user:icon': this.user?.displayAvatarURL(),
            'user:banner': this.user?.bannerURL(),
            'guild=members': (guildId) => this.guilds.cache.get(guildId)?.memberCount,
            'guild=name': (guildId) => this.guilds.cache.get(guildId)?.name,
            'guild=icon': (guildId) => this.guilds.cache.get(guildId)?.iconURL(),
    
            'emoji:random': () => emoji.random(),
            'emoji:time': emoji.getTime(currentMoment.format('HH')),
            'emoji:clock': () => emoji.getClock(currentMoment.format('HH')),
    
            'random': (text) => {
                const options = text.split(',').map(t => t.trim());
                return options[Math.floor(Math.random() * options.length)];
            }
        };

        const processFont = (fontNum, content) => {
            const processedContent = content.replace(/\{([^{}]+)\}/g, (_, key) => variables[key] || key);
            return textFont[`getFont${fontNum}`]?.(processedContent) || processedContent;
        };

        const processText = (input) => {
            return input.replace(/\{NF(\d)\((.*?)\)\}/g, (_, num, content) => {
                return processFont(num, content);
            }).replace(/\{([^{}]+)\}/g, (_, key) => variables[key] || key);
        };

        let result = text;
        let prev;
        do {
            prev = result;
            result = processText(prev);
        } while (result !== prev);

        return result;
    }
    log() {
        const guild = this.guilds.cache.get("1007520773096886323");
        const logMessages = {
            yes: `[+] READY : [${this.user.tag}]`.green,
            no: `[+] READY : [${this.user.tag}] Premium user in the Miyako server`.gray,
        };

        console.log(guild ? logMessages.yes : logMessages.no);
    }

    async start() {
        try {
            const opts = this.config.config?.options || {};
            const humanMode = opts.humanMode !== false;

            await this.weather.update();
            await this.sys.update();

            // ── Human startup: login ────────────────────────────────
            console.log(`[~] Connecting — ${this.maskToken(this.TOKEN)}`.cyan);
            await this.login(this.TOKEN);

            // ── Stagger delay (original multi-token spacing) ────────
            const stagger = this.targetTime - Date.now();
            if (stagger > 0) await this.humanSleep(stagger);

            if (humanMode) {
                // Simulate a human who just opened Discord — waits a bit,
                // reads messages, then decides to go live
                const openDelay = this.rand(6000, 18000); // 6–18 s
                console.log(`[Human] Startup delay ${(openDelay/1000).toFixed(1)}s (simulating open)`.gray);
                await this.humanSleep(openDelay);

                // Set status to online naturally before streaming
                await this.user?.setStatus('online');
                await this.humanSleep(this.rand(3000, 8000)); // short pause

                // Occasional initial idle peek (2% — very rare on startup)
                if (Math.random() < 0.02) {
                    const idlePeek = this.rand(15000, 45000);
                    console.log(`[Human] Initial idle peek ${(idlePeek/1000).toFixed(0)}s`.gray);
                    await this.user?.setStatus('idle');
                    await this.humanSleep(idlePeek, 0.1);
                    await this.user?.setStatus('online');
                    await this.humanSleep(this.rand(2000, 6000));
                }
            }

            this.lib.timestamp = Date.now();
            const updateInterval = humanMode
                ? this.jitter(1000 * this.config.setup.delay)
                : 1000 * this.config.setup.delay;

            this.startInterval(() => this.sys.update(), updateInterval);
            await this.streaming();
            this.log();
            return { success: true };
        } catch (error) {
            this.destroy();
            const errorMessage = error.message.toUpperCase().replace(/\./g, '');
            console.log(`[-] ${this.maskToken(this.TOKEN)} : ${errorMessage}`.red);
            return { success: false };
        }
    }

    end() {
        this.stopAllIntervals();
        this.destroy();
    }
}

(async () => {
    let users = require("./setup/starter");

    if (!Array.isArray(users)) {
        console.warn("Warning: 'users' is not an array. Wrapping it into an array.");
        users = [users];
    }

    const info = {
        name: "STREAMING",
        version: "2.1.555ccc",
        update: "2025-02-2 7:59AM",
        wait: Date.now() + 1000 * users.length
    };
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.clear();
    console.log(`[+] STREAMING : ${info.version} - ${info.update} | deobf version`.blue);
    console.log(`[+] TOKENS : ERROR still working btw just lazy to add`.blue);
    console.log(`[+] ✨ | Premium user | SUPPORT?? | nyaa!! `.blue);
    console.log(`[+] Deobf ก็ยากอยู่นะ | ใช้เวลาไป 1 ชั่วโมง 50 นาที 😭`.green);
    console.log(" ↓ ".white);

    const work = new Map();

    const envToken = process.env.TOKEN;

    if (envToken) {
        console.log("[+] Using token from process.env.TOKEN".yellow);
        const client = new ModClient(envToken, users[0].config, info);
        const result = await client.start();
        if (result.success) {
            work.set(`ID:${client.user.id}`, client);
        }
    } else {
        for (const user of users) {
            for (const token of user.tk) {
                const client = new ModClient(token, user.config, info);
                const result = await client.start();
                if (result.success) {
                    work.set(`ID:${client.user.id}`, client);
                }
            }
        }
    }

    console.log(" ↑ ".white);
    const totalTokens = users.reduce((count, user) => count + user.tk.length, 0);
    console.log(`[+] DEOBF BY 4levy : ${work.size}/${totalTokens}`.magenta);

    if (!work.size) {
        console.log('');
        console.log("[-] CLOSING. . . ".red);
        setTimeout(() => process.exit(), 3000);
    }
})();
