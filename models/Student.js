const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  studentId: { type: String, required: true },
  class: { type: String, required: false },
  amount: { type: Number, required: true },
  isPaid: { type: Boolean, default: false }
});

module.exports = mongoose.model('Student', studentSchema);