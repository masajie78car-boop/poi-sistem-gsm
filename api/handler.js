// === IMPORTS ===
import fetch from "node-fetch";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set, update, remove } from "firebase/database";

// === FIREBASE CONFIG ===
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.AUTH_DOMAIN,
  projectId: process.env.PROJECT_ID,
  storageBucket: process.env.STORAGE_BUCKET,
  messagingSenderId: process.env.MESSAGING_SENDER_ID,
  appId: process.env.APP_ID,
  databaseURL: process.env.DATABASE_URL,
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// === VERCEL CONFIG ===
export const config = { api: { bodyParser: true } };

// ===============================
// 🔵 MAIN HANDLER
// ===============================
export default async function handler(req, res) {

  // =====================================================
  // ✅ 1) VERIFIKASI WEBHOOK DARI FACEBOOK (WAJIB)
  // =====================================================
  if (req.method === "GET") {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Verification failed");
  }

  // =====================================================
  // ✅ 2) EVENT POST — PESAN DARI WHATSAPP
  // =====================================================
  if (req.method === "POST") {
    res.status(200).send("EVENT_RECEIVED");

    try {
      const change = req.body.entry?.[0]?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      if (!message) return;

      const from = message.from;
      const text = (message.text?.body || "").trim();
      const lower = text.toLowerCase();

      // Auto reset setiap hari
      await dailyReset("mall_nusantara");
      await dailyReset("stasiun_jatinegara");

      if (lower.startsWith("#daftarantrian")) {
        await daftar(from, text, "mall_nusantara");
      } else if (lower.startsWith("#updateantrian")) {
        await updateList(from, "mall_nusantara");
      } else if (lower.startsWith("#daftarlist")) {
        await daftar(from, text, "stasiun_jatinegara");
      } else if (lower.startsWith("#updatelist")) {
        await updateList(from, "stasiun_jatinegara");
      } else {
        await sendMessage(from, "⚠️ Format tidak dikenal.");
      }

    } catch (err) {
      console.error("POST error:", err);
    }

    return;
  }

  return res.status(405).send("Method Not Allowed");
}

// =====================================================
// 🔵 ADMIN PANEL — AKSI panggil / selesai / hapus
// =====================================================
if (typeof globalThis !== "undefined") {
  globalThis.onAdminRequest = async function (req, res) {
    const action = req.query.action;
    const lokasi = req.query.lokasi;
    const noPol = req.query.noPol;

    if (req.query.admin_key !== process.env.ADMIN_KEY) {
      return res.status(401).send("Unauthorized");
    }

    try {
      if (action === "panggil") {
        const snap = await get(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`));
        const data = snap.val();

        if (!data) return res.status(404).send("Not found");
        if (!data.from) return res.status(400).send("No phone stored");

        await sendMessage(data.from, `📣 ${data.noPol} silakan menuju lobby`);
        await sendToGroup(lokasi, `📣 Memanggil: ${data.noPol}`);
        return res.status(200).send("ok");
      }

      if (action === "selesai") {
        await update(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`), {
          status: "selesai",
        });

        const allSnap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
        const all = allSnap.val() || {};
        const arr = Object.values(all);

        const aktif = arr.filter((x) => x.status === "aktif");
        const buffer = arr.filter((x) => x.status === "buffer");

        if (aktif.length < 3 && buffer.length > 0) {
          const promote = buffer[0];
          await update(
            ref(db, `pangkalan/${lokasi}/antrian/${promote.noPol}`),
            { status: "aktif" }
          );
        }

        await sendToGroup(lokasi, `✅ Selesai: ${noPol}`);
        return res.status(200).send("ok");
      }

      if (action === "hapus") {
        await remove(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`));
        await sendToGroup(lokasi, `🗑️ Dihapus: ${noPol}`);
        return res.status(200).send("ok");
      }

      return res.status(400).send("Unknown action");
    } catch (err) {
      console.error("Admin error:", err);
      return res.status(500).send("Server error");
    }
  };
}

// =====================================================
// 🔵 FUNGSI — DAFTAR ANTRIAN
// =====================================================
async function daftar(from, text, lokasi) {
  const parts = text.split(/\s+/);
  const noPol = (parts[1] || "").toUpperCase();

  if (!noPol) {
    return sendMessage(from, "❌ Format: #daftarantrian B1234XYZ");
  }

  const snap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
  const data = snap.val() || {};
  const aktif = Object.values(data).filter((d) => d.status === "aktif");

  const status = aktif.length >= 3 ? "buffer" : "aktif";

  await set(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`), {
    noPol,
    from,
    status,
    createdAt: new Date().toISOString(),
  });

  await sendMessage(from, `✅ ${noPol} terdaftar sebagai ${status}`);
  await sendToGroup(lokasi, `🆕 Antrian baru: ${noPol} (${status})`);
}

// =====================================================
// 🔵 FUNGSI — UPDATE LIST
// =====================================================
async function updateList(from, lokasi) {
  const snap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
  const data = snap.val() || {};

  if (!Object.keys(data).length) {
    return sendMessage(from, "📋 Belum ada antrian.");
  }

  const arr = Object.values(data);
  arr.sort((a, b) => (a.createdAt || "") > (b.createdAt || "") ? 1 : -1);

  const list = arr
    .map((d, i) => `${i + 1}. ${d.noPol} (${d.status})`)
    .join("\n");

  await sendMessage(from, `📋 Antrian:\n${list}`);
}

// =====================================================
// 🔵 RESET HARIAN (JAM 00:00 JAKARTA)
// =====================================================
async function dailyReset(lokasi) {
  const metaRef = ref(db, `pangkalan/${lokasi}/_meta`);
  const meta = (await get(metaRef)).val() || {};

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
  });

  if (meta.lastReset !== today) {
    await set(ref(db, `pangkalan/${lokasi}/antrian`), {});
    await set(metaRef, { lastReset: today });
  }
}

// =====================================================
// 🔵 SEND MESSAGE KE USER WA
// =====================================================
async function sendMessage(to, text) {
  const token = process.env.ACCESS_TOKEN;
  const phoneId = process.env.PHONE_ID;

  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }),
  });
}

// =====================================================
// 🔵 SEND MESSAGE KE GROUP WA (broadcast)
// =====================================================
async function sendToGroup(lokasi, text) {
  const token = process.env.ACCESS_TOKEN;
  const phoneId = process.env.PHONE_ID;

  const groupId =
    lokasi === "mall_nusantara"
      ? process.env.GROUP_ID_MALL
      : process.env.GROUP_ID_JATINEGARA;

  if (!groupId) return;

  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: groupId,
      text: { body: text },
    }),
  });
}
