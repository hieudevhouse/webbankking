const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const PayOS = require('@payos/node');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Kết nối MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Kết nối MongoDB thành công'))
  .catch(err => console.error('Lỗi kết nối MongoDB:', err));

// Định nghĩa schema và model cho Student
const studentSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  studentId: { type: String, required: true },
  amount: { type: Number, required: true, default: 0 },
  paymentStatus: { type: String, default: 'incomplete' },
  orderCode: { type: String, unique: true }
});
const Student = mongoose.model('Student', studentSchema);

// Cấu hình PayOS
const payOS = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// Trang câu hỏi
app.get('/', async (req, res) => {
  res.render('question');
});
// Trang thanh toán
app.get('/index', async (req, res) => {
  try {
    const students = await Student.find({});
    res.render('index', { students });
  } catch (err) {
    console.error('Lỗi khi lấy danh sách sinh viên:', err.message);
    res.status(500).send('Lỗi server: ' + err.message);
  }
});

app.post('/create-payment', async (req, res) => {
  const { email, amount } = req.body;

  if (!email || !amount || isNaN(amount) || parseInt(amount) <= 0) {
    console.error('Dữ liệu đầu vào không hợp lệ:', { email, amount: parseInt(amount) });
    return res.status(400).json({ error: 'Dữ liệu đầu vào không hợp lệ' });
  }

  try {
    const student = await Student.findOne({ email });
    if (!student) {
      console.error('Không tìm thấy sinh viên:', email);
      return res.status(404).json({ error: 'Sinh viên không tồn tại' });
    }

    if (student.paymentStatus === 'complete') {
      console.error('Sinh viên đã thanh toán:', email);
      return res.status(400).json({ error: 'Không thể tạo mã thanh toán cho sinh viên đã thanh toán.' });
    }

    const orderCode = Date.now() + Math.floor(Math.random() * 1000);

    const paymentData = {
      orderCode: orderCode,
      amount: parseInt(amount),
      description: `Thanh toán cho ${student.name.slice(0, 15)}`.slice(0, 25),
      returnUrl: process.env.RETURN_URL || 'http://localhost:3000/success', // Sử dụng biến môi trường hoặc mặc định
      cancelUrl: process.env.CANCEL_URL || 'http://localhost:3000/cancel',
      buyerName: student.name,
      buyerEmail: student.email,
      items: [{ name: 'Thanh Toán', quantity: 1, price: parseInt(amount) }]
    };

    console.log('paymentData:', paymentData);
    console.log('orderCode type:', typeof paymentData.orderCode);

    const paymentLinkResponse = await payOS.createPaymentLink(paymentData);
    if (!paymentLinkResponse || !paymentLinkResponse.checkoutUrl) {
      console.error('Không nhận được URL thanh toán từ PayOS');
      throw new Error('Không nhận được URL thanh toán từ PayOS');
    }

    student.orderCode = orderCode.toString(); // Chuyển orderCode thành chuỗi để đảm bảo đồng bộ
    student.paymentStatus = 'pending';
    await student.save();

    res.json({ checkoutUrl: paymentLinkResponse.checkoutUrl });
  } catch (error) {
    console.error('Lỗi khi tạo link thanh toán:', error.message);
    res.status(500).json({ error: 'Lỗi khi tạo link thanh toán', details: error.message });
  }
});

// Endpoint xử lý callback từ PayOS
app.post('/payos-callback', async (req, res) => {
  console.log('Nhận được callback từ PayOS:', req.body); // Log toàn bộ dữ liệu callback

  const { orderCode } = req.body;

  // Kiểm tra dữ liệu đầu vào
  if (!orderCode) {
    console.error('Callback thiếu orderCode:', req.body);
    return res.status(400).json({ error: 'Dữ liệu callback không hợp lệ' });
  }

  try {
    // Tìm sinh viên dựa trên orderCode
    const student = await Student.findOne({ orderCode: orderCode.toString() });
    if (!student) {
      console.error('Không tìm thấy sinh viên với orderCode:', orderCode);
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    // Lấy thông tin giao dịch từ PayOS
    const paymentInfo = await payOS.getPaymentLinkInformation(orderCode);
    const paymentAmount = parseInt(paymentInfo.amount); // Tiền đơn hàng
    const amountPaid = parseInt(paymentInfo.amountPaid); // Tiền đã thanh toán

    console.log('Payment info from PayOS:', { orderCode, paymentAmount, amountPaid });

    // So sánh amount và amountPaid
    if (paymentAmount === amountPaid) {
      student.paymentStatus = 'complete';
      await student.save();
      console.log(`Thanh toán hoàn tất cho sinh viên ${student.email}, orderCode: ${orderCode}`);
      return res.status(200).json({ message: 'Thanh toán hoàn tất', status: 'success' });
    } else {
      console.error('Số tiền không khớp:', { paymentAmount, amountPaid });
      return res.status(400).json({ error: 'Số tiền thanh toán không khớp với số tiền đơn hàng' });
    }
  } catch (error) {
    console.error('Lỗi xử lý callback:', error.message);
    return res.status(500).json({ error: 'Lỗi server', details: error.message });
  }
});

// Trang thành công
app.get('/success', async (req, res) => {
  const { orderCode } = req.query;
  if (orderCode) {
    try {
      const student = await Student.findOne({ orderCode: orderCode.toString() });
      if (!student) {
        console.error('Không tìm thấy sinh viên với orderCode:', orderCode);
        return res.render('success');
      }

      // Kiểm tra trạng thái thanh toán dự phòng
      const paymentInfo = await payOS.getPaymentLinkInformation(orderCode);
      const paymentAmount = parseInt(paymentInfo.amount);
      const amountPaid = parseInt(paymentInfo.amountPaid);

      console.log('Success route - Payment info:', { orderCode, paymentAmount, amountPaid });

      if (paymentAmount === amountPaid && student.paymentStatus !== 'complete') {
        student.paymentStatus = 'complete';
        await student.save();
        console.log(`Cập nhật trạng thái hoàn tất (success route) cho sinh viên ${student.email}, orderCode: ${orderCode}`);
      }
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái trong /success:', err.message);
    }
  } else {
    console.warn('Không có orderCode trong /success:', req.query);
  }
  res.render('success');
});

// Trang hủy
app.get('/cancel', (req, res) => {
  res.render('cancel');
});

// Trang admin (đăng nhập)
app.get('/admin', (req, res) => res.render('admin-login'));

app.post('/admin/login', (req, res) => {
  const { email, password, code } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD && code === process.env.ADMIN_2FA) {
    res.redirect('/admin/dashboard');
  } else {
    res.send('Đăng nhập thất bại');
  }
});

app.get('/admin/dashboard', async (req, res) => {
  try {
    const students = await Student.find({});
    const paidCount = students.filter(s => s.paymentStatus === 'complete').length;
    const unpaidCount = students.filter(s => s.paymentStatus === 'incomplete' || s.paymentStatus === 'pending').length;
    res.render('admin-dashboard', { students, paidCount, unpaidCount });
  } catch (err) {
    console.error('Lỗi khi lấy dashboard:', err.message);
    res.status(500).send('Lỗi server: ' + err.message);
  }
});

app.post('/admin/add-student', async (req, res) => {
  const { email, name, studentId, amount } = req.body;
  console.log('Dữ liệu nhận được:', req.body);

  // Kiểm tra dữ liệu đầu vào
  if (!email || !name || !studentId || !amount) {
    console.error('Thiếu dữ liệu khi thêm sinh viên:', { email, name, studentId, amount });
    return res.status(400).json({ error: 'Tất cả các trường đều bắt buộc.' });
  }

  // Kiểm tra định dạng email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error('Email không hợp lệ:', email);
    return res.status(400).json({ error: 'Email không hợp lệ.' });
  }

  // Kiểm tra amount
  const parsedAmount = parseInt(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    console.error('Số tiền không hợp lệ:', amount);
    return res.status(400).json({ error: 'Số tiền phải là một số dương.' });
  }

  try {
    // Kiểm tra email đã tồn tại
    const existingStudent = await Student.findOne({ email });
    if (existingStudent) {
      console.error('Email đã tồn tại:', email);
      return res.status(400).json({ error: 'Email đã tồn tại, vui lòng sử dụng email khác.' });
    }

    // Tạo sinh viên mới
    const orderCode = Date.now() + Math.floor(Math.random() * 1000);
    const newStudent = new Student({
      email,
      name,
      studentId,
      amount: parsedAmount,
      paymentStatus: 'incomplete',
      orderCode: orderCode.toString()
    });

    await newStudent.save();
    console.log('Thêm sinh viên thành công:', email);
    return res.status(200).json({ message: 'Thêm sinh viên thành công', redirect: '/admin/dashboard' });
  } catch (err) {
    if (err.code === 11000) {
      console.error('Email đã tồn tại:', email);
      return res.status(400).json({ error: 'Email đã tồn tại, vui lòng sử dụng email khác.' });
    }
    console.error('Lỗi khi thêm sinh viên:', {
      message: err.message,
      code: err.code,
      stack: err.stack
    });
    return res.status(500).json({ error: `Lỗi server: ${err.message}` });
  }
});
app.get('/admin/export-students', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Students');
    worksheet.columns = [
      { header: 'Số thứ tự', key: 'stt', width: 10 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Tên', key: 'name', width: 20 },
      { header: 'Mã SV', key: 'studentId', width: 15 },
      { header: 'Số Tiền', key: 'amount', width: 15 },
      { header: 'Trạng thái đóng tiền', key: 'paymentStatus', width: 20 }
    ];
    const students = await Student.find({});
    students.forEach((student, index) => {
      worksheet.addRow({
        stt: index + 1,
        email: student.email,
        name: student.name,
        studentId: student.studentId,
        amount: student.amount,
        paymentStatus: student.paymentStatus
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=students.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Lỗi xuất Excel:', err.message);
    res.status(500).send('Lỗi server: ' + err.message);
  }
});

app.listen(port, () => {
  console.log(`Server đang chạy tại http://localhost:${port}`);
});