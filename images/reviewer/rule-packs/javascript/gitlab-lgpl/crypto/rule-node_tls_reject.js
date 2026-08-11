// License: GNU Lesser General Public License v3.0
// Rule ref: rules_lgpl_javascript_crypto_rule-node-tls-reject

function tests () {
  console.log('Running TestNodeLibCurl')
  test1()
  test2()
  test3()
  test4()
  test5()
}

// Vulnerable
// NODE_TLS_REJECT_UNAUTHORIZED set to '0'
// Bracket Notation
function test1 () {
  console.log(
    'Running Test1 - NODE_TLS_REJECT_UNAUTHORIZED set to "0" (Bracket Notation)'
  )
  const https = require('https')
  // ruleid: rules_lgpl_javascript_crypto_rule-node-tls-reject
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
  const options = {
    hostname: 'myserver',
    port: 8443,
    path: '/',
    method: 'GET'
  }

  const req = https.request(options, res => {
    console.log(`Test 1 - Status Code: ${res.statusCode}`)

    let data = ''
    res.on('data', chunk => {
      data += chunk
    })

    res.on('end', () => {
      console.log('Test 1 - Response Body:', data)
    })
  })

  req.on('error', e => {
    console.error(`Test 1 - Error: ${e.message}`)
  })

  req.end()

  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
}

// Not Vulnerable - Will not connect with the server that has a self-signed certificate
// NODE_TLS_REJECT_UNAUTHORIZED set to '1'
function test2 () {
  console.log('Running Test2 (SAFE) - NODE_TLS_REJECT_UNAUTHORIZED set to "1"')
  const https = require('https')
  // ok: rules_lgpl_javascript_crypto_rule-node-tls-reject
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
  const options = {
    hostname: 'myserver',
    port: 8443,
    path: '/',
    method: 'GET'
  }

  const req = https.request(options, res => {
    console.log(`Test 2 - Status Code: ${res.statusCode}`)

    let data = ''
    res.on('data', chunk => {
      data += chunk
    })

    res.on('end', () => {
      console.log('Test 2 - Response Body:', data)
    })
  })

  req.on('error', e => {
    console.error(`Test 2 - Error: ${e.message}`)
  })

  req.end()
}

// Vulnerable
// NODE_TLS_REJECT_UNAUTHORIZED set to 0 (without quotes)
// Bracket Notation
function test3 () {
  console.log('Running Test3 - NODE_TLS_REJECT_UNAUTHORIZED set to false')
  const https = require('https')
  // ruleid: rules_lgpl_javascript_crypto_rule-node-tls-reject
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0
  const options = {
    hostname: 'myserver',
    port: 8443,
    path: '/',
    method: 'GET'
  }

  const req = https.request(options, res => {
    console.log(`Test 3 - Status Code: ${res.statusCode}`)

    let data = ''
    res.on('data', chunk => {
      data += chunk
    })

    res.on('end', () => {
      console.log('Test 3 - Response Body:', data)
    })
  })

  req.on('error', e => {
    console.error(`Test 3 - Error: ${e.message}`)
  })

  req.end()
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
}

// Vulnerable
// NODE_TLS_REJECT_UNAUTHORIZED set to "0"
// dot notation
function test4 () {
  console.log(
    'Running Test4 - NODE_TLS_REJECT_UNAUTHORIZED set to 0 (dot notation)'
  )
  const https = require('https')
  // ruleid: rules_lgpl_javascript_crypto_rule-node-tls-reject
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const options = {
    hostname: 'myserver',
    port: 8443,
    path: '/',
    method: 'GET'
  }

  const req = https.request(options, res => {
    console.log(`Test 4 - Status Code: ${res.statusCode}`)

    let data = ''
    res.on('data', chunk => {
      data += chunk
    })

    res.on('end', () => {
      console.log('Test 4 - Response Body:', data)
    })
  })

  req.on('error', e => {
    console.error(`Test 4 - Error: ${e.message}`)
  })

  req.end()
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
}

// Vulnerable
// NODE_TLS_REJECT_UNAUTHORIZED set to 0 (without quotes)
// dot notation
function test5 () {
  console.log(
    'Running Test5 - NODE_TLS_REJECT_UNAUTHORIZED set to 0 (without quotes, dot notation)'
  )
  const https = require('https')
  // ruleid: rules_lgpl_javascript_crypto_rule-node-tls-reject
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0
  const options = {
    hostname: 'myserver',
    port: 8443,
    path: '/',
    method: 'GET'
  }

  const req = https.request(options, res => {
    console.log(`Test 5 - Status Code: ${res.statusCode}`)

    let data = ''
    res.on('data', chunk => {
      data += chunk
    })

    res.on('end', () => {
      console.log('Test 5 - Response Body:', data)
    })
  })

  req.on('error', e => {
    console.error(`Test 5 - Error: ${e.message}`)
  })

  req.end()
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1'
}

tests()
