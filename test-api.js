const assert = require('assert');

const BASE_URL = 'http://localhost:5000/api';
const timestamp = Date.now();
// สร้าง username แบบสุ่มเล็กน้อยเพื่อให้รันเทสซ้ำ ๆ ได้โดยไม่ติดปัญหาชื่อซ้ำใน DB
const testUser = { username: `user_${timestamp}`, password: 'password123' };
const hackerUser = { username: `hacker_${timestamp}`, password: 'hackerpass' };

let userToken = '';
let hackerToken = '';
let targetTodoId = null;

const results = [];

// ฟังก์ชันช่วยจำลองสไตล์การแสดงผลแบบ Jest
async function test(description, fn) {
    try {
        await fn();
        results.push({ description, status: '✅ PASS' });
    } catch (error) {
        results.push({ description, status: '❌ FAIL', error: error.message });
    }
}

async function runTests() {
    console.log('🚀 Starting API Automation Tests...\n');

    // ========================================================
    // 1. AUTHENTICATION TESTS
    // ========================================================
    
    await test('POST /api/register -> สมัครสมาชิกใหม่สำเร็จ', async () => {
        const res = await fetch(`${BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testUser)
        });
        assert.strictEqual(res.status, 201);
    });

    await test('POST /api/register -> สมัครสมาชิกซ้ำชื่อเดิม ต้องถูกปฏิเสธ', async () => {
        const res = await fetch(`${BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testUser)
        });
        assert.strictEqual(res.status, 400);
    });

    await test('POST /api/login -> ใช้รหัสผิด ต้องเข้าสู่ระบบไม่ได้', async () => {
        const res = await fetch(`${BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: testUser.username, password: 'wrongpassword' })
        });
        assert.strictEqual(res.status, 400);
    });

    await test('POST /api/login -> ข้อมูลถูกต้อง ต้องได้ JWT Token กลับมา', async () => {
        const res = await fetch(`${BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testUser)
        });
        const data = await res.json();
        assert.strictEqual(res.status, 200);
        assert.ok(data.token);
        userToken = data.token; // เก็บ Token ไว้ใช้ในสเต็ปถัดไป
    });

    // ========================================================
    // 2. TODO CRUD TESTS
    // ========================================================

    await test('GET /api/todos -> พยายามดึงข้อมูลโดยไม่มี Token ต้องโดนบล็อก (401)', async () => {
        const res = await fetch(`${BASE_URL}/todos`);
        assert.strictEqual(res.status, 401);
    });

    await test('GET /api/todos -> ใช้ Token ที่ถูกต้อง ดึงลิสต์ว่างเริ่มต้นสำเร็จ', async () => {
        const res = await fetch(`${BASE_URL}/todos`, {
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        const data = await res.json();
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(data));
    });

    await test('POST /api/todos -> เพิ่ม Todo สำเร็จ', async () => {
        const res = await fetch(`${BASE_URL}/todos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userToken}`
            },
            body: JSON.stringify({ title: 'เขียนโปรเจกต์ด้วย React และ Express' })
        });
        const data = await res.json();
        assert.strictEqual(res.status, 201);
        assert.ok(data.id);
        targetTodoId = data.id; // เก็บ ID ไปใช้เทสการ Update / Delete
    });

    await test('PUT /api/todos/:id -> อัปเดตสถานะ (ติ๊กทำแล้ว) สำเร็จ', async () => {
        const res = await fetch(`${BASE_URL}/todos/${targetTodoId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userToken}`
            },
            body: JSON.stringify({ is_completed: 1 })
        });
        assert.strictEqual(res.status, 200);
    });

    // ========================================================
    // 3. SECURITY & PRIVACY TESTS (การข้ามสิทธิ์)
    // ========================================================

    await test('SECURITY -> สมัครบัญชี Hacker และ Login เพื่อเอา Token แฮกเกอร์', async () => {
        // สร้างอีกไอดีนึงขึ้นมาขนานกัน
        await fetch(`${BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hackerUser)
        });
        const res = await fetch(`${BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hackerUser)
        });
        const data = await res.json();
        hackerToken = data.token;
        assert.ok(hackerToken);
    });

    await test('SECURITY -> แฮกเกอร์พยายามลบ Todo ของเรา ต้องโดนบล็อก (404)', async () => {
        const res = await fetch(`${BASE_URL}/todos/${targetTodoId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${hackerToken}` }
        });
        // ต้องหาไม่เจอ หรือไม่มีสิทธิ์ลบ
        assert.strictEqual(res.status, 404);
    });

    await test('DELETE /api/todos/:id -> เจ้าของตัวจริงลบ Todo ของตัวเอง สำเร็จ', async () => {
        const res = await fetch(`${BASE_URL}/todos/${targetTodoId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${userToken}` }
        });
        assert.strictEqual(res.status, 200);
    });

    // ========================================================
    // สรุปผลการทดสอบ
    // ========================================================
    console.log('\n================ Test Report Summary ================');
    let passCount = 0;
    results.forEach(res => {
        console.log(`${res.status} : ${res.description}`);
        if (res.status === '✅ PASS') passCount++;
        else console.log(`   ⚠️ Error: ${res.error}`);
    });
    console.log('=====================================================');
    console.log(`📊 Total: ${results.length} | Passed: ${passCount} | Failed: ${results.length - passCount}\n`);
}

runTests();
