// License: GNU Lesser General Public License v3.0
// source (original): https://github.com/ajinabraham/njsscan/blob/master/tests/assets/node_source/true_positives/semantic_grep/jwt/jwt_hardcoded.js
// hash: e7a0a61
const jwt = require("jsonwebtoken");
const jose = require("jose")

const secretKey = "this is the secret key"

module.exports = function (app) {

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/1
    app.get('/jwt/hardcoded-jwt-secret/jsonwebtoken/1', (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        const token = jwt.sign(payload, secretKey, { algorithm: 'HS256' });

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        jwt.verify(token, secretKey, { algorithms: ['RS256', 'HS256'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/2
    app.get('/jwt/hardcoded-jwt-secret/jsonwebtoken/2', (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        const token = jwt.sign(payload, "Key", { algorithm: 'HS256' });

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        jwt.verify(token, "Key", { algorithms: ['RS256', 'HS256'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jose/1
    app.get('/jwt/hardcoded-jwt-secret/jose/1', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const key = new TextEncoder().encode(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2'
        )

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        let token = await new jose.SignJWT(payload)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer('urn:example:issuer')
            .setAudience('urn:example:audience')
            .setExpirationTime('2h')
            .sign(key);

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        const tokenDecrypted = await jose.jwtVerify(token, key, { algorithms: ['HS256'] }, {
            issuer: 'urn:example:issuer',
            audience: 'urn:example:audience',
        });

        res.send("Token: " + tokenDecrypted)
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jose/2
    app.get('/jwt/hardcoded-jwt-secret/jose/2', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const key = new TextEncoder().encode(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
        )

        let jwt = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256', sign_type: 'SIGN' });
        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        let token = await jwt.sign(key);

        res.send({ token })
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jose/3
    app.get('/jwt/hardcoded-jwt-secret/jose/3', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const key = Uint8Array.from(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
        )

        let jwt = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256', sign_type: 'SIGN' });
        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        let token = await jwt.sign(key);

        res.send({ token })
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jose/4
    app.get('/jwt/hardcoded-jwt-secret/jose/4', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        let jwt = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256', sign_type: 'SIGN' });

        // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        let token = await jwt.sign(Uint8Array.from(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
        ));

        res.send({ token })
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jose/safe-1
    app.get('/jwt/hardcoded-jwt-secret/jose/safe-1', async (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };
        const key = Uint8Array.from(
            process.env.SECRET,
        )

        let jwt = new jose.SignJWT(payload).setProtectedHeader({ alg: 'HS256', sign_type: 'SIGN' });
        // ok: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        let token = await jwt.sign(key);

        // ok: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        const tokenDecrypted = await jose.jwtVerify(token, Uint8Array.from(
            process.env.SECRET,
        ), { algorithms: ['HS256'] }, {
            issuer: 'urn:example:issuer',
            audience: 'urn:example:audience',
        });

        res.send({ token, tokenDecrypted })
    })

    // http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/safe-1
    app.get('/jwt/hardcoded-jwt-secret/jsonwebtoken/safe-1', (req, res) => {
        const payload = { user_id: 123, username: 'john_doe' };

        // ok: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        const token = jwt.sign(payload, process.env.SECRET, { algorithm: 'HS256' });
        
        const sk = process.env.SECRET;
        // ok: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
        jwt.verify(token, sk, { algorithms: ['RS256', 'HS256'] }, (err, decoded) => {
            if (err) {
                console.error('Token verification failed:', err.message);
            } else {
                console.log('Token verified successfully:', decoded);
            }
        });

        res.send("Check server console")
    })
}

import express from "express";
import jwt from "jsonwebtoken"
import * as jose from 'jose'

const router = express.Router();

// http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/1
router.route("/jsonwebtoken/1").get((req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };
    const secretKey = 'This is a secret key';

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const token = jwt.sign(payload, secretKey);
    res.send(token)
})

// http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/2
router.route("/jsonwebtoken/2").get((req, res) => {
    const secretKey = 'This is a secret key';
    const token = req.query.token;
    
    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    jwt.verify(token, secretKey, (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err.message);
        } else {
            console.log('Token verified successfully:', decoded);
        }
    });

    res.send("Check server console")
})

// http://localhost:3000/jwt/hardcoded-jwt-secret/jsonwebtoken/3
router.route("/jsonwebtoken/3").get((req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const token = jwt.sign(payload, 'This is a secret key', { algorithm: 'HS256' });
    
    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    jwt.verify(token, 'This is a secret key', (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err.message);
        } else {
            console.log('Token verified successfully:', decoded);
        }
    });

    res.send("Check server console")
})

// http://localhost:3000/jwt/hardcoded-jwt-secret/jose/1
router.route("/jose/1").get(async (req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };
    const key = new TextEncoder().encode(
        'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
    )

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const token = await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('urn:example:issuer')
        .setAudience('urn:example:audience')
        .setExpirationTime('2h')
        .sign(key)

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const tokenDecrypted = await jose.jwtVerify(token, key, { algorithms: ['HS256'] }, {
        issuer: 'urn:example:issuer',
        audience: 'urn:example:audience',
    });

    res.send("Token: " + tokenDecrypted)
})

// http://localhost:3000/jwt/hardcoded-jwt-secret/jose/2
router.route("/jose/2").get(async (req, res) => {
    const payload = { user_id: 123, username: 'john_doe' };

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const token = await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setIssuer('urn:example:issuer')
        .setAudience('urn:example:audience')
        .setExpirationTime('2h')
        .sign(new TextEncoder().encode(
            'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
        ))

    // ruleid: rules_lgpl_javascript_jwt_rule-hardcoded-jwt-secret
    const tokenDecrypted = await jose.jwtVerify(token,new TextEncoder().encode(
        'cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2',
    ), { algorithms: ['HS256'] }, {
        issuer: 'urn:example:issuer',
        audience: 'urn:example:audience',
    });

    res.send("Token: " + tokenDecrypted)
})

export default router;