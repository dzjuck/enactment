// License: GNU Lesser General Public License v3.0
// source (original): https://github.com/ajinabraham/njsscan/blob/master/tests/assets/node_source/true_positives/semantic_grep/jwt/jwt_none_algorithm.js
// hash: e7a0a61
import express from "express";
import jwt from "jsonwebtoken"
import * as jose from 'jose'

const router = express.Router();

// http://localhost:3000/jwt/none-algorithem/sign
router.route("/sign").get((req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };
    const secretKey = 'This is a secret key';

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    const token = jwt.sign(payload, secretKey);
    console.log('Generated Token:', token);
    res.send(token)
})

// http://localhost:3000/jwt/none-algorithem/verify
router.route("/verify").get((req, res) => {
    const secretKey = 'This is a secret key';
    const token = req.query.token;
    console.log('Generated Token:', token);

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    jwt.verify(token, secretKey, (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err.message);
        } else {
            console.log('Token verified successfully:', decoded);
        }
    });

    res.send("Check server console")
})

// http://localhost:3000/jwt/none-algorithem/sign-n-verify
router.route("/sign-n-verify").get((req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };
    const secretKey = 'This is a secret key';

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    const token = jwt.sign(payload, secretKey, { algorithm: 'HS256' });
    console.log('Generated Token:', token);

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    jwt.verify(token, secretKey, (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err.message);
        } else {
            console.log('Token verified successfully:', decoded);
        }
    });

    res.send("Check server console")
})

// http://localhost:3000/jwt/none-algorithem/jose/sign-n-verify
router.route("/jose/sign-n-verify").get(async (req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };
    const key = new TextEncoder().encode(
        'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
    )

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    const token = await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('urn:example:issuer')
        .setAudience('urn:example:audience')
        .setExpirationTime('2h')
        .sign(key)

    console.log('Generated Token: ', token);

    // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
    const tokenDecrypted = await jose.jwtVerify(token, key, { algorithms: ['HS256'] }, {
        issuer: 'urn:example:issuer',
        audience: 'urn:example:audience',
    });

    console.log({ tokenDecrypted })
    res.send("Token: " + tokenDecrypted)
})

export default router;

const jwt = require("jsonwebtoken");
const jose = require("jose")
const { generateKeyPairSync } = require('crypto');

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

module.exports = function (app) {

    // http://localhost:3000/jwt-none-algorithm/jwt/
    app.get('/jwt-none-algorithm/jwt', (req, res) => {
        // ruleid: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        var token = jwt.sign({ foo: 'bar' }, "", { algorithm: "none" });
        res.send(token)
    })

    // http://localhost:3000/jwt/jwt-none-algorithm/verify
    app.get('/jwt/jwt-none-algorithm/verify', (req, res) => {
        const token = req.query.token;
        const secretKey = '';

        // ruleid: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        jwt.verify(token, secretKey, { algorithms: ['none'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })

    // http://localhost:3000/jwt/jwt-none-algorithm/sign-n-verify/1
    app.get('/jwt/jwt-none-algorithm/sign-n-verify/1', (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const secretKey = '';

        // ruleid: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        const token = jwt.sign(payload, secretKey, { algorithm: 'none' });

        console.log('Generated Token:', token);


        // ruleid: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        jwt.verify(token, secretKey, { algorithms: ['RS256', 'none'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })

    // http://localhost:3000/jwt/jwt-none-algorithm/sign-n-verify/2
    app.get('/jwt/jwt-none-algorithm/sign-n-verify/2', (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };

        // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });

        console.log('Generated Token:', token);

        // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        jwt.verify(token, publicKey, { algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })

    // http://localhost:3000/jose/jwt-none-algorithm
    app.get('/jose/jwt-none-algorithm', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const key = new TextEncoder().encode(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
        )

        // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        const token = await new jose.SignJWT(payload)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('urn:example:issuer')
            .setAudience('urn:example:audience')
            .setExpirationTime('2h')
            .sign(key)

        console.log('Generated Token: ', token);

        // ok: rules_lgpl_javascript_jwt_rule-node-jwt-none-algorithm
        const tokenDecrypted = await jose.jwtVerify(token, key, { algorithms: ['HS256'] }, {
            issuer: 'urn:example:issuer',
            audience: 'urn:example:audience',
        });

        console.log({ tokenDecrypted })
        res.send("Token: " + tokenDecrypted)
    })
}