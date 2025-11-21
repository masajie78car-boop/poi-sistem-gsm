// api/handler.js - KODE LENGKAP YANG DIKOREKSI
import fetch from "node-fetch";
import * as admin from 'firebase-admin'; // Admin SDK
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, get, set, update, remove } from 'firebase/database';

// Inisialisasi Admin SDK
try {
  // PENTING: Untuk serverless, Admin SDK perlu Service Account Key di ENV
  admin.initializeApp(); 
} catch(e) {
  // Hanya menangkap error jika sudah diinisialisasi
}


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
  
  // --- VERIFIKASI KEAMANAN ADMIN ACTIONS ---
  if (req.query?.action) {
    const action = req.query.action;
    
    if (action === 'panggil' || action === 'selesai' || action === 'hapus') {
      const token = req.headers.authorization?.split('Bearer ')[1];
      
      if (!token) {
        return res.status(401).send('Unauthorized: Token missing');
      }
      
      try {
        await admin.auth().verifyIdToken(token); 
      } catch(e) {
        return res.status(401).send('Unauthorized: Invalid token');
      }

      if (
        (action === 'panggil' && req.method !== 'POST') ||
        (action === 'selesai' && req.method !== 'PUT') ||
        (action === 'hapus' && req.method !== 'DELETE')
      ) {
        return res.status(405).send(`Method Not Allowed for action ${action}`);
      }

      // --- LOGIKA AKSI ADMIN ---
      const lokasi = req.query.lokasi;
      const noPol = req.query.noPol;
      
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
      } catch(err) {
        console.error('Admin action error', err);
        return res.status(500).send('Server error');
      }
    }
  }
  // --- END: VERIFIKASI KEAMANAN ADMIN ACTIONS ---

  // Webhook verification (GET)
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

  // Webhook receive (POST) - DI SINI ensureDailyReset DIPANGGIL
  if (req.method === 'POST') {
    res.status(200).send('EVENT_RECEIVED'); // Respons cepat untuk WA
    try {
      const change = req.body.entry?.[0]?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      if (!message) return;
      const from = message.from;
      const text = (message.text?.body || '').trim();
      const textLower = text.toLowerCase();
      
      // PANGGILAN FUNGSI ensureDailyReset (Pastikan definisinya ada di bawah)
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
      console.error('Webhook error:', err.message); // Tampilkan pesan error spesifik
    }
    return;
  }

  return res.status(405).send('Method Not Allowed');
}

// =================================================================
// SEMUA HELPER FUNCTIONS HARUS ADA DI SINI (SETELAH export default)
// =================================================================

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
    
    // Log hasil pengiriman
    if (!r.ok) {
      const txt = await r.text();
      console.error('WA send failed. Status:', r.status, 'Body:', txt); 
    } else {
      console.log('WA message sent successfully to:', to); 
    }

  } catch(err) {
    console.error('Fetch error sendMessage', err);
  }
}
