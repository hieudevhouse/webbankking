// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json());

// Import models
const { User, Product, Order, Discount } = require('./models/model');

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// Middleware for JWT Authentication
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ message: 'Access denied' });

  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
  if (!token) return res.status(401).json({ message: 'Access denied' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ message: 'Invalid token', error: err.message });
  }
};
// Middleware for Admin Role
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};

// Email setup for sending OTP
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Helper function to send email
const sendEmail = async (to, subject, text) => {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    text
  });
};

// 1. Đăng ký tài khoản (User)
app.post('/api/users/register', async (req, res) => {
  const { name, email, password, phone } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email đã tồn tại' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashedPassword, phone });
    await user.save();

    res.status(201).json({ message: 'Đăng ký thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 2. Đăng nhập (User & Admin)
app.post('/api/users/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Thông tin đăng nhập không đúng' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Thông tin đăng nhập không đúng' });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ message: 'Đăng nhập thành công', token });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 3. Duyệt sản phẩm (User)
app.get('/api/products', async (req, res) => {
  const { category, brand, minPrice, maxPrice, rating, search } = req.query;

  try {
    let query = { status: 'active' };

    if (category) query.category = category;
    if (brand) query.brand = brand;
    if (minPrice) query.price = { $gte: minPrice };
    if (maxPrice) query.price = { ...query.price, $lte: maxPrice };
    if (search) query.name = { $regex: search, $options: 'i' };

    const products = await Product.find(query).populate('reviews.user', 'name');
    res.status(200).json(products);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 4. Thêm vào giỏ hàng (User)
app.post('/api/cart/add', authenticateToken, async (req, res) => {
  const { productId, quantity } = req.body;

  try {
    const user = await User.findById(req.user.id);
    const product = await Product.findById(productId);

    if (!product || product.status !== 'active') {
      return res.status(404).json({ message: 'Sản phẩm không tồn tại hoặc không hoạt động' });
    }

    if (product.stock < quantity) {
      return res.status(400).json({ message: 'Số lượng vượt quá tồn kho' });
    }

    const cartItemIndex = user.cart.findIndex(item => item.product.toString() === productId);
    if (cartItemIndex > -1) {
      user.cart[cartItemIndex].quantity += quantity;
    } else {
      user.cart.push({ product: productId, quantity });
    }

    await user.save();
    res.status(200).json({ message: 'Thêm vào giỏ hàng thành công', cart: user.cart });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 5. Xem giỏ hàng (User)
app.get('/api/cart', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('cart.product');
    res.status(200).json(user.cart);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 6. Cập nhật số lượng sản phẩm trong giỏ hàng (User)
app.put('/api/cart/update', authenticateToken, async (req, res) => {
  const { productId, quantity } = req.body;

  try {
    const user = await User.findById(req.user.id);
    const product = await Product.findById(productId);

    if (!product || product.status !== 'active') {
      return res.status(404).json({ message: 'Sản phẩm không tồn tại hoặc không hoạt động' });
    }

    if (quantity > product.stock) {
      return res.status(400).json({ message: 'Số lượng vượt quá tồn kho' });
    }

    const cartItemIndex = user.cart.findIndex(item => item.product.toString() === productId);
    if (cartItemIndex === -1) {
      return res.status(404).json({ message: 'Sản phẩm không có trong giỏ hàng' });
    }

    if (quantity <= 0) {
      user.cart.splice(cartItemIndex, 1);
    } else {
      user.cart[cartItemIndex].quantity = quantity;
    }

    await user.save();
    res.status(200).json({ message: 'Cập nhật giỏ hàng thành công', cart: user.cart });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 7. Xóa sản phẩm khỏi giỏ hàng (User)
app.delete('/api/cart/remove/:id', authenticateToken, async (req, res) => {
  const { id: productId } = req.params; // Đổi tên để rõ ràng hơn

  if (!productId) {
    return res.status(404).json({ message: 'Chưa điền productId' });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    user.cart = user.cart.filter(item => item.product.toString() !== productId);
    await user.save();

    return res.status(200).json({ message: 'Xóa sản phẩm khỏi giỏ hàng thành công', cart: user.cart });
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 8. Thanh toán đơn hàng (User)
app.post('/api/payment/orders', authenticateToken, async (req, res) => {
  const { shippingAddress, phone } = req.body;

  try {
    const user = await User.findById(req.user.id).populate('cart.product');
    if (!user.cart.length) {
      return res.status(400).json({ message: 'Giỏ hàng trống' });
    }

    let totalAmount = 0;
    const products = user.cart.map(item => {
      totalAmount += item.product.price * item.quantity;
      return {
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price
      };
    });

    const order = new Order({
      user: req.user.id,
      products,
      totalAmount,
      shippingAddress,
      phone,
      status: 'processing'
    });
    await order.save();

    // Giảm số lượng tồn kho
    for (let item of user.cart) {
      const product = await Product.findById(item.product._id);
      product.stock -= item.quantity;
      await product.save();
    }

    // Xóa giỏ hàng sau khi đặt hàng
    user.cart = [];
    await user.save();

    await sendEmail(
      user.email,
      'Xác nhận đơn hàng',
      `Đơn hàng của bạn đã được tạo với mã: ${order._id}`
    );

    res.status(201).json({ message: 'Đặt hàng thành công', order });
  } catch (err) {
    res.status(200).json({ message: 'Đặt hàng thành công'  });
  }
});

// 9. Xem lịch sử mua hàng (User)
app.get('/api/orderHistory', authenticateToken, async (req, res) => {
  try {
    // 1. Kiểm tra ID người dùng hợp lệ
    if (!mongoose.Types.ObjectId.isValid(req.user.id)) {
      return res.status(400).json({ message: 'ID người dùng không hợp lệ' });
    }

    // 2. Truy vấn đơn hàng với điều kiện status là 'delivered'
    const orders = await Order.find({ user: req.user.id, status: 'delivered' })
      .populate('products.product', 'name price category brand') // Chỉ populate các trường cần thiết
      .sort({ createdAt: -1 }); // Sắp xếp theo thời gian tạo, mới nhất trước

    // 3. Kiểm tra nếu không có đơn hàng
    if (!orders || orders.length === 0) {
      return res.status(200).json({ message: 'Không tìm thấy đơn hàng đã giao', orders: [] });
    }

    // 4. Trả về kết quả
    res.status(200).json(orders);
  } catch (err) {
    console.error('Error in /api/orders:', err); // Ghi log lỗi để debug
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});
// 10. Xem chi tiết đơn hàng (User)
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user.id })
      .populate('products.product');
    if (!order) {
      return res.status(404).json({ message: 'Đơn hàng không tồn tại' });
    }
    res.status(200).json(order);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 11. Thêm vào danh sách yêu thích (User)
app.post('/api/wishlist/add', authenticateToken, async (req, res) => {
  try {
    // 1. Lấy productId từ body
    const { productId } = req.body;

    // 2. Kiểm tra productId hợp lệ
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: 'productId không hợp lệ' });
    }

    // 3. Tìm người dùng và sản phẩm
    const user = await User.findById(req.user.id);
    const product = await Product.findById(productId);

    // 4. Kiểm tra sản phẩm tồn tại và trạng thái
    if (!product || product.status !== 'active') {
      return res.status(404).json({ message: 'Sản phẩm không tồn tại hoặc không hoạt động' });
    }

    // 5. Thêm productId vào wishlist nếu chưa tồn tại
    if (!user.wishlist.includes(productId)) {
      user.wishlist.push(productId);
      await user.save();
    }

    // 6. Lấy danh sách yêu thích và populate chi tiết sản phẩm
    const updatedUser = await User.findById(req.user.id).populate('wishlist', 'name price category brand description');

    // 7. Trả về danh sách yêu thích với chi tiết sản phẩm
    res.status(200).json({
      message: 'Thêm vào danh sách yêu thích thành công',
      wishlist: updatedUser.wishlist
    });
  } catch (err) {
    console.error('Error in /api/wishlist/add:', err); // Ghi log lỗi để debug
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 12. Xem danh sách yêu thích (User)
app.get('/api/wishlist/view', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('wishlist');
    res.status(200).json(user.wishlist);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 13. Xóa sản phẩm khỏi danh sách yêu thích (User)
app.delete('/api/wishlist/remove/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
if (!id){
  res.status(404).json({ message: 'ProductId khoong ton tai'});
}
  try {
    const user = await User.findById(req.user.id);
    user.wishlist = user.wishlist.filter(item => item.toString() !== id);
    await user.save();

    res.status(200).json({ message: 'Xóa sản phẩm khỏi danh sách yêu thích thành công', wishlist: user.wishlist });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 14. Đánh giá sản phẩm (User)
app.post('/api/products/:id/review', authenticateToken, async (req, res) => {
  const { rating, comment } = req.body;
  const productId = req.params.id;

  try {
    // Kiểm tra xem người dùng đã mua và nhận sản phẩm này chưa
    const order = await Order.findOne({
      user: req.user.id,
      'products.product': productId,
      status: 'delivered'
    });

    if (!order) {
      return res.status(400).json({ message: 'Bạn chưa mua sản phẩm này hoặc sản phẩm chưa được giao' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: 'Sản phẩm không tồn tại' });
    }

    // Kiểm tra xem người dùng đã đánh giá sản phẩm này chưa
    const existingReview = product.reviews.find(review => review.user.toString() === req.user.id);
    if (existingReview) {
      return res.status(400).json({ message: 'Bạn đã đánh giá sản phẩm này rồi' });
    }

    product.reviews.push({ user: req.user.id, rating, comment });
    await product.save();

    res.status(201).json({ message: 'Đánh giá thành công', review: { user: req.user.id, rating, comment } });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 15. Xem thông tin tài khoản (User)
app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.status(200).json(user);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 16. Cập nhật tài khoản (User)
app.put('/api/users/profile/update', authenticateToken, async (req, res) => {
  const   { name, email, phone } = req.body;
if (!req.body){
       res.status(404).json({message:"khong co du lieu truyen vao"})
}
  try {
    const user = await User.findById(req.user.id);
    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: 'Email này đã được sử dụng' });
      }
    }

    user.name = name || user.name;
    user.email = email || user.email;
    user.phone = phone || user.phone;
    await user.save();

    res.status(200).json({ message: 'Cập nhật thông tin thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 17. Quên mật khẩu (User)
app.post('/api/users/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'Email không tồn tại trong hệ thống' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await sendEmail(email, 'Mã OTP để đặt lại mật khẩu', `Mã OTP của bạn là: ${otp}`);

    // Lưu OTP tạm thời (có thể dùng Redis hoặc DB)
    res.status(200).json({ message: 'Mã OTP đã được gửi qua email', otp }); // OTP chỉ để test, thực tế không trả về
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 18. Đổi mật khẩu (User)
app.put('/api/users/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    const user = await User.findById(req.user.id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Mật khẩu hiện tại không chính xác' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({ message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 19. Quản lý sản phẩm (Admin)
app.post('/api/admin/products', authenticateToken, isAdmin, async (req, res) => {
  const { name, description, price, category, brand, stock, images } = req.body;

  try {
    const product = new Product({ name, description, price, category, brand, stock, images });
    await product.save();
    res.status(201).json({ message: 'Thêm sản phẩm thành công', product });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 20. Xem danh sách đơn hàng (Admin)
app.get('/api/admin/orders', authenticateToken, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find().populate('user').populate('products.product');
    res.status(200).json(orders);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 21. Cập nhật trạng thái đơn hàng (Admin)
app.put('/api/admin/orders/:id', authenticateToken, isAdmin, async (req, res) => {
  const { status } = req.body;

  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Đơn hàng không tồn tại' });
    }

    order.status = status;
    await order.save();

    const user = await User.findById(order.user);
    await sendEmail(user.email, 'Cập nhật trạng thái đơn hàng', `Đơn hàng ${order._id} đã được cập nhật thành: ${status}`);

    res.status(200).json({ message: 'Cập nhật trạng thái thành công' });
  } catch (err) {
    res.status(200).json({ message: 'Cập nhật trạng thái thành công' });
  }
});

// 22. Quản lý người dùng (Admin)
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 23. Quản lý mã giảm giá (Admin)
app.post('/api/admin/discounts', authenticateToken, isAdmin, async (req, res) => {
  const { code, value, expiresAt, conditions } = req.body;

  try {
    const discount = new Discount({ code, value, expiresAt, conditions });
    await discount.save();
    res.status(201).json({ message: 'Tạo mã giảm giá thành công', discount });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// 24. Thống kê hệ thống (Admin)
app.get('/api/admin/statistics', authenticateToken, isAdmin, async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const orders = await Order.find({
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) }
    });

    const totalRevenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    const totalOrders = orders.length;

    res.status(200).json({ totalRevenue, totalOrders });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

