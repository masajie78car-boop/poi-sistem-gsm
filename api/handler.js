// api/handler.js
import fetch from "node-fetch";
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, get, set, update, remove } from 'firebase/database';

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

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // Admin actions
  if (req.method === 'GET' && req.query?.action) {
    const action = req.query.action;
    const lokasi = req.query.lokasi;
    const noPol = req.query.noPol;
    if (process.env.ADMIN_KEY && req.query.admin_key !== process.env.ADMIN_KEY) {
      return res.status(401).send('Unauthorized');
    }
    try {
      if (action === 'panggil') {
        const snap = await get(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`));
        const data = snap.val();
        if (!data) return res.status(404).send('Not found');
        if (!data.from) return res.status(400).send('No phone number on record');
        await sendMessage(data.from, `Antrian ${data.noPol} silahkan menuju lobby`);
        return res.status(200).send('ok');
      }
      if (action === 'selesai') {
        const snap = await get(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`));
        const item = snap.val();
        if (!item) return res.status(404).send('Not found');
        await update(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`), { status: 'selesai' });
        const allSnap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
        const all = allSnap.val() || {};
        const arr = Object.values(all).map(x => ({ ...x }));
        arr.sort((a,b) => (a.createdAt || '') > (b.createdAt || '') ? 1 : -1);
        const aktif = arr.filter(x => x.status === 'aktif');
        const buffer = arr.filter(x => x.status === 'buffer');
        if (aktif.length < 3 && buffer.length > 0) {
          const promote = buffer[0];
          await update(ref(db, `pangkalan/${lokasi}/antrian/${promote.noPol}`), { status: 'aktif' });
        }
        return res.status(200).send('ok');
      }
      if (action === 'hapus') {
        await remove(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`));
        return res.status(200).send('ok');
      }
      return res.status(400).send('Unknown action');
    } catch(err) {
      console.error('Admin action error', err);
      return res.status(500).send('Server error');
    }
  }

  // Webhook verification
  if (req.method === 'GET') {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  // Webhook receive
  if (req.method === 'POST') {
    // respond early
    res.status(200).send('EVENT_RECEIVED');
    try {
      const change = req.body.entry?.[0]?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      if (!message) return;
      const from = message.from;
      const text = (message.text?.body || '').trim();
      const textLower = text.toLowerCase();
      await ensureDailyReset('mall_nusantara');
      await ensureDailyReset('stasiun_jatinegara');
      if (textLower.startsWith('#daftarantrian')) {
        await handleDaftar(from, text, 'mall_nusantara');
      } else if (textLower.startsWith('#updateantrian')) {
        await handleUpdate(from, 'mall_nusantara');
      } else if (textLower.startsWith('#daftarlist')) {
        await handleDaftar(from, text, 'stasiun_jatinegara');
      } else if (textLower.startsWith('#updatelist')) {
        await handleUpdate(from, 'stasiun_jatinegara');
      } else {
        await sendMessage(from, '⚠️ Format tidak dikenal.');
      }
    } catch(err) {
      console.error('Webhook error', err);
    }
    return;
  }

  return res.status(405).send('Method Not Allowed');
}

// helpers
async function handleDaftar(from, text, lokasi) {
  const parts = text.split(/\s+/);
  const noPol = (parts[1] || '').toUpperCase();
  if (!noPol) {
    return sendMessage(from, '❌ Format salah. Gunakan: #daftarantrian B1234XYZ');
  }
  const snap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
  const data = snap.val() || {};
  const aktif = Object.values(data).filter(d => d.status === 'aktif');
  const status = aktif.length >= 3 ? 'buffer' : 'aktif';
  await set(ref(db, `pangkalan/${lokasi}/antrian/${noPol}`), {
    noPol,
    status,
    from,
    createdAt: new Date().toISOString()
  });
  await sendMessage(from, `✅ ${noPol} terdaftar di ${lokasi.replace('_',' ')}\nStatus: ${status}`);
}

async function handleUpdate(from, lokasi) {
  const snap = await get(ref(db, `pangkalan/${lokasi}/antrian`));
  const data = snap.val() || {};
  if (!Object.keys(data).length) {
    return sendMessage(from, '📋 Belum ada antrian aktif.');
  }
  const list = Object.values(data).map((d,i) => `${i+1}. ${d.noPol} (${d.status})`).join('\n');
  await sendMessage(from, `📋 Antrian ${lokasi.replace('_',' ')}:\n${list}`);
}

function todayJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

async function ensureDailyReset(lokasi) {
  const metaRef = ref(db, `pangkalan/${lokasi}/_meta`);
  const snapMeta = await get(metaRef);
  const meta = snapMeta.val() || {};
  const lastReset = meta.lastResetDate || null;
  const today = todayJakarta();
  if (lastReset !== today) {
    await set(ref(db, `pangkalan/${lokasi}/antrian`), {});
    await set(metaRef, { lastResetDate: today });
  }
}

async function sendMessage(to, text) {
  const token = process.env.ACCESS_TOKEN;
  const phoneId = process.env.PHONE_ID;
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, text: { body: text } })
    });

    // --- BARIS LOG BARU ---
    if (!r.ok) {
      const txt = await r.text();
      console.error('WA send failed. Status:', r.status, 'Body:', txt); 
    } else {
      console.log('WA message sent successfully to:', to);
    }
    // --- AKHIR LOG BARU ---

  } catch(err) {
    console.error('Fetch error sendMessage', err);
  }
}
