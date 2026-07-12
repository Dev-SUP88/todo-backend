const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_KEY);

const googleAuth = require('google-auth-library');
require('dotenv').config();

const client = new googleAuth.OAuth2Client('929898429344-17ufedipqrcsbe0io5t807t32p3usqbr.apps.googleusercontent.com');

const app = express();
app.use(express.json());
app.use(cors());

// 1. เชื่อมต่อ Database
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT // <-- ต้องมีบรรทัดนี้ ไม่งั้นพอร์ต 443 ที่เราตั้งไว้ใน Render จะไม่มีประโยชน์เลย!
});



// 2. Middleware ตรวจสอบความปลอดภัย (JWT Authentication)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or Expired Token' });
        req.user = user; // ส่งข้อมูล user (id, username) ไปยัง endpoint ถัดไป
      console.log(req.user);
        next();
    });
};

// 💳 1. API สำหรับสร้างหน้าต่างชำระเงิน Stripe ฿38
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    // แกะ userId จาก token (สมมติว่าพี่มีระบบแกะ req.user.id จาก middleware ล็อกอินอยู่แล้ว)
    const userId = 6; 

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "promptpay"], // 🇹🇭 เปิดรับทั้งบัตรเครดิตและ PromptPay QR ของไทย!
      line_items: [
        {
          price_data: {
            currency: "thb", // บังคับสกุลเงินบาท
            product_data: {
              name: "Todo List Premium 💎",
              description: "ปลดล็อกฟีเจอร์ปรับแต่งสีสันรายการ Todo ได้ตามใจชอบตลอดชีพ",
            },
            unit_amount: 3800, // ฿38.00 (หน่วยของ Stripe เป็นสตางค์ เลยต้องคูณ 100 ครับ)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      // หน้าเว็บที่จะให้ Stripe เด้งกลับไปหาหลังจากจ่ายตังค์สำเร็จ/ยกเลิก
      success_url: `https://todo-backend-sk7n.onrender.com/api/payment-success?userId=${userId}`, 
      cancel_url: `https://todo-backend-sk7n.onrender.com/api/payment-cancel`,
    });

    // ส่งลิงก์ชำระเงินกลับไปให้หน้าบ้านเปิด
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "ไม่สามารถสร้างรายการชำระเงินได้" });
  }
});


// 🎉 2. ด่านรับสายตอนจ่ายเงินสำเร็จ -> อัปเดตข้อมูลผู้ใช้ใน DB
app.get("/api/payment-success", async (req, res) => {
  const { userId } = req.query;

  if (!userId) return res.status(400).send("ไม่พบข้อมูลผู้ใช้");

  try {
    // 🗄️ ยิง SQL ไปเปลี่ยนสถานะผู้ใช้ในตารางเป็นพรีเมียม!
    // (แก้ชื่อตาราง/ตัวแปรคิวรี่ db ให้ตรงตามโครงสร้างของโปรเจกต์พี่นะครับ)
    await db.query("UPDATE users SET is_premium = 1 WHERE id = ?", [userId]);

    // พออัปเดตเบสเสร็จ ให้ดีดผู้ใช้กลับไปที่หน้าแรกของหน้าบ้านเราพร้อมส่งตัวแปรบอกว่าสำเร็จ
    // (แก้ URL หน้าบ้านด้านล่างนี้ให้ตรงกับหน้าเว็บพี่นะ)
    res.redirect("http://localhost:5173/?payment=success"); 
  } catch (err) {
    console.error(err);
    res.status(500).send("เกิดข้อผิดพลาดในการอัปเดตสิทธิ์พรีเมียม");
  }
});

// ❌ 3. ด่านรับสายตอนลูกค้ายกเลิกการจ่ายเงิน
app.get("/api/payment-cancel", (req, res) => {
  res.redirect("http://localhost:5173/?payment=cancel");
});



// ==========================================
// AUTH ROUTES (Register & Login)
// ==========================================

app.post('/api/google-login', async (req, res) => {
    const { token } = req.body; // 1. หน้าบ้านยิง Token ที่ได้จาก Google มาให้ที่นี่

    try {
        // 2. ส่ง Token ไปให้ Google ตรวจสอบความถูกต้อง
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: '929898429344-17ufedipqrcsbe0io5t807t32p3usqbr.apps.googleusercontent.com'
        });
        const payload = ticket.getPayload(); 
        const { email, name } = payload; // ดึงอีเมลและชื่อจริงจาก Google

        // 3. เช็คในฐานข้อมูล MySQL ของเราว่าเคยมีอีเมลนี้ไหม
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

        let user = users[0];

        if (!user) {
            // 🌟 เคสที่ 1: ยังไม่มีอีเมลนี้ในระบบ (สมัครสมาชิกใหม่สด ๆ)
            // ใช้ชื่อจาก Google ตั้งเป็น username ไปก่อน ส่วน password ปล่อยเป็น NULL
            const [result] = await pool.query(
                'INSERT INTO users (username, email, password) VALUES (?, ?, NULL)',
                [name, email]
            );
            
            // ดึงข้อมูลยูสเซอร์ที่เพิ่งสร้างขึ้นมา
            const [newUser] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
            user = newUser[0];
        }

        // 🌟 เคสที่ 2: มีอีเมลนี้อยู่แล้ว (หรือสร้างเสร็จจากเคสด้านบนแล้ว)
        // 4. สร้าง JWT Token ของแอปเราเอง เพื่อให้หน้าบ้านเอาไว้ใช้ล็อกอินในหน้าถัด ๆ ไป
        // (ถ้าระบบเดิมนายใช้ Session หรือไม่ได้ใช้ JWT สามารถตัดท่อน sign นี้ออกแล้วส่ง user กลับไปตรง ๆ ได้เลยครับ)
        const mySystemToken = jwt.sign(
            { id: user.id, username: user.username, email: user.email },
            process.env.JWT_SECRET || 'SECRET_KEY_ของนาย',
            { expiresIn: '1d' }
        );

        // 5. ส่งข้อมูลกลับไปบอกหน้าบ้านว่า "ผ่านด่านแล้วจ้า!"
        res.json({
            message: "Google Login Successful!",
            token: mySystemToken,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });

    } catch (error) {
        console.error("Google Auth Error:", error);
        res.status(400).json({ error: "Invalid Google Token" });
    }
});

// สมัครสมาชิก (ความปลอดภัย: Hash รหัสผ่านด้วย bcrypt)
// แก้ไขโค้ดใน server.js ตรงส่วน Register ให้เป็นแบบนี้:
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Please fill all fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        // เปลี่ยนมาเช็คผ่าน message หรือ code ให้ครอบคลุม
        if (error.code === 'ER_DUP_ENTRY' || (error.message && error.message.includes('Duplicate entry'))) {
            return res.status(400).json({ message: 'Username already exists' });
        }
        res.status(500).json({ error: error.message });
    }
});


// เข้าสู่ระบบ (สร้าง JWT Token)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(400).json({ message: 'User not found' });

        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Invalid password' });

        // สร้าง Token (หมดอายุใน 1 วัน)
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.json({ token, message: 'Logged in successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// TODO ROUTES (ต้องมี Token ถึงจะเข้าถึงได้)
// ==========================================

// ดึงข้อมูล Todo ทั้งหมด "เฉพาะของตัวเอง"
app.get('/api/todos', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// เพิ่ม Todo ใหม่
app.post('/api/todos', authenticateToken, async (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });

    try {
        const [result] = await pool.query('INSERT INTO todos (user_id, title) VALUES (?, ?)', [req.user.id, title]);
        res.status(201).json({ id: result.insertId, title, is_completed: 0 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// แก้ไขเนื้อหา หรือ ติ๊กสถานะทำแล้ว/ยังไม่ได้ทำ (ความปลอดภัย: เช็ค user_id เสมอ)
app.put('/api/todos/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { title, is_completed } = req.body; // ส่งมาเฉพาะตัวที่จะแก้ก็ได้

    try {
        // ดึงข้อมูลเดิมมาดูก่อนเพื่ออัปเดตแบบ Dynamic
        const [rows] = await pool.query('SELECT * FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Todo not found or unauthorized' });

        const currentTodo = rows[0];
        const newTitle = title !== undefined ? title : currentTodo.title;
        const newStatus = is_completed !== undefined ? is_completed : currentTodo.is_completed;

        await pool.query('UPDATE todos SET title = ?, is_completed = ? WHERE id = ? AND user_id = ?', 
            [newTitle, newStatus, id, req.user.id]);

        res.json({ message: 'Todo updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ลบ Todo (ความปลอดภัย: ลบได้เฉพาะของตัวเองเท่านั้น)
app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Todo not found or unauthorized' });
        }
        res.json({ message: 'Todo deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
