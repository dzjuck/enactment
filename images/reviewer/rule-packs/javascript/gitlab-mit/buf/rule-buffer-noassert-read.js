const buffer = Buffer.alloc(10) // Allocate a buffer of 10 bytes

function testBufferMethods (buf) {
  // Vulnerable read methods
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readUInt8(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readUInt16LE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readUInt16BE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readUInt32LE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readUInt32BE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readInt8(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readInt16LE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readInt16BE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readInt32LE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readInt32BE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readFloatLE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readFloatBE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readDoubleLE(20, true)
  // ruleid: javascript_buf_rule-buffer-noassert-read
  buf.readDoubleBE(20, true)

  // ok: javascript_buf_rule-buffer-noassert-read
  buf.readUInt8(20)
}

try {
  testBufferMethods(buffer)
} catch (error) {
  console.error('Caught an error:', error)
}
