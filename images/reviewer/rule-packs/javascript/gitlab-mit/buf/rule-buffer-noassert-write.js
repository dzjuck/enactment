const buffer = Buffer.alloc(10) // Allocate a buffer of 10 bytes

function testBufferMethods (buf) {
  // Vulnerable write methods
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeUInt8(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeUInt16LE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeUInt16BE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeUInt32LE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeUInt32BE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeInt8(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeInt16LE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeInt16BE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeInt32LE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeInt32BE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeFloatLE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeFloatBE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeDoubleLE(0, 20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-write
  buf.writeDoubleBE(0, 20, true)

  // ok: javascript_buf_rule-buffer-noassert-write
  buf.writeDoubleBE(0, 20, false)
}

try {
  testBufferMethods(buffer)
} catch (error) {
  console.error('Caught an error:', error)
}
