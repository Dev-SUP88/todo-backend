const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

const googleAuth = require('google-auth-library');
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
    port: process.env.DB_PORT
});

// 2. Middleware ตรวจสอบความปลอดภัย (JWT Authentication)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ message: 'Access Denied: No Token Provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or Expired Token' });
        req.user = user;
        next();
    });
};

// 💳 1. API สำหรับสร้างหน้าต่างชำระเงิน Stripe ฿38 (🌟 ซ่อม: ใส่ authenticateToken เรียบร้อย)
app.post("/api/create-checkout-session", authenticateToken, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null; 
    if (!userId) return res.status(401).json({ error: "ไม่พบข้อมูลผู้ใช้" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "promptpay"],
      line_items: [
        {
          price_data: {
            currency: "thb",
            product_data: {
              name: "Todo List Premium 💎",
              description: "ปลดล็อกฟีเจอร์ปรับแต่งสีสันรายการ Todo ได้ตามใจชอบตลอดชีพ",
            },
            unit_amount: 3800,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `https://todo-backend-sk7n.onrender.com/api/payment-success?userId=${userId}`, 
      cancel_url: `https://todo-backend-sk7n.onrender.com/api/payment-cancel`,
    });

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
    // อัปเดตสิทธิ์ในฐานข้อมูล
    await pool.query("UPDATE users SET is_premium = 1 WHERE id = ?", [userId]);

    // 📌 ตรงนี้ต้องเปลี่ยนจาก localhost เป็น URL หน้าบ้านตัวจริงของพี่เวลาอัปขึ้นโฮสต์จริงนะครับ!
    res.redirect("http://localhost:5173/?payment=success"); 
  } catch (err) {
    console.error(err);
    res.status(500).send("เกิดข้อผิดพลาดในการอัปเดตสิทธิ์พรีเมียม");
  }
});

// ❌ 3. ด่านรับสายตอนลูกค้ายกเลิกการจ่ายเงิน
app.get("/api/payment-cancel", (req, res) => {
  // 📌 ตรงนี้ด้วยเช่นกันครับ เปลี่ยนเป็น URL หน้าบ้านตัวจริง
  res.redirect("http://localhost:5173/?payment=cancel");
});


// ==========================================
// AUTH ROUTES
// ==========================================

app.post('/api/google-login', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: '929898429344-17ufedipqrcsbe0io5t807t32p3usqbr.apps.googleusercontent.com'
        });
        const payload = ticket.getPayload(); 
        const { email, name } = payload;

        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        let user = users[0];

        if (!user) {
            // สมัครสมาชิกใหม่ (🌟 เสริมข้อมูลเบื้องต้น คลีนรหัสผ่าน)
            const [result] = await pool.query(
                'INSERT INTO users (username, email, password, is_premium) VALUES (?, ?, NULL, 0)',
                [name, email]
            );
            const [newUser] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
            user = newUser[0];
        }

        // ฝังตัวแปรเพิ่มใน JWT Token
        const mySystemToken = jwt.sign(
            { id: user.id, username: user.username, email: user.email, is_premium: user.is_premium },
            process.env.JWT_SECRET || 'SECRET_KEY',
            { expiresIn: '1d' }
        );

        // 🌟 ส่งเฉพาะข้อมูลจำเป็น และพ่นสถานะพรีเมียมกลับไปด้วยเพื่อให้หน้าบ้านรับรู้ทันที
        res.json({
            message: "Google Login Successful!",
            token: mySystemToken,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                is_premium: user.is_premium // 👈 เพิ่มตัวนี้เพื่อให้หน้าบ้านดึงไปใช้ได้เลย
            }
        });
    } catch (error) {
        console.error("Google Auth Error:", error);
        res.status(400).json({ error: "Invalid Google Token" });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Please fill all fields' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, is_premium) VALUES (?, ?, 0)', [username, hashedPassword]);
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || (error.message && error.message.includes('Duplicate entry'))) {
            return res.status(400).json({ message: 'Username already exists' });
        }
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return res.status(400).json({ message: 'User not found' });

        const user = rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Invalid password' });

        // ฝังตัวแปรพรีเมียมลงในก้อน Token ด้วย
        const token = jwt.sign({ id: user.id, username: user.username, is_premium: user.is_premium }, process.env.JWT_SECRET, { expiresIn: '1d' });
        
        res.json({ 
            token, 
            message: 'Logged in successfully',
            is_premium: user.is_premium // 👈 ส่งกลับไปบอกหน้าบ้านตรงๆ
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔍 API สำหรับเช็คสถานะและข้อมูลผู้ใช้ล่าสุด (ใส่ไว้ต่อจากท่อน Auth หรือก่อน Todo Routes)
app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        // ยิงไปดึงข้อมูลล่าสุดจากฐานข้อมูลจริง เพื่อดูว่าจ่ายตังค์หรือยัง
        const [rows] = await pool.query('SELECT id, username, email, is_premium FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
        
        res.json({ user: rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// TODO ROUTES 
// ==========================================

app.get('/api/todos', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/todos', authenticateToken, async (req, res) => {
    const { title } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });

    try {
        // 🌟 ตั้งค่าเริ่มต้นตอนสร้างงานให้บันทึกรหัสสีขาว (#ffffff) ลงไปด้วยตามโครงสร้างตารางใหม่
        const [result] = await pool.query('INSERT INTO todos (user_id, title, color_code) VALUES (?, ?, "#ffffff")', [req.user.id, title]);
        res.status(201).json({ id: result.insertId, title, is_completed: 0, color_code: "#ffffff" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/todos/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { title, is_completed, color_code } = req.body; // 🎨 รองรับการส่ง color_code เข้ามาเปลี่ยนสี

    try {
        const [rows] = await pool.query('SELECT * FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Todo not found or unauthorized' });

        const currentTodo = rows[0];
        const newTitle = title !== undefined ? title : currentTodo.title;
        const newStatus = is_completed !== undefined ? is_completed : currentTodo.is_completed;
        const newColor = color_code !== undefined ? color_code : currentTodo.color_code; // เช็คเรื่องสี

        await pool.query('UPDATE todos SET title = ?, is_completed = ?, color_code = ? WHERE id = ? AND user_id = ?', 
            [newTitle, newStatus, newColor, id, req.user.id]);

        res.json({ message: 'Todo updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/todos/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM todos WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Todo not found or unauthorized' });
        res.json({ message: 'Todo deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
