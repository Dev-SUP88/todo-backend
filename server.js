const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

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
        next();
    });
};

// ==========================================
// AUTH ROUTES (Register & Login)
// ==========================================

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
