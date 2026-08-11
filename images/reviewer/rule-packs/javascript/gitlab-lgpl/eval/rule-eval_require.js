// License: GNU Lesser General Public License v3.0
// source (original): https://github.com/ajinabraham/njsscan/blob/master/tests/assets/node_source/true_positives/semantic_grep/eval/eval_require.js
// hash: e7a0a61

// Testing using 'child_process' package
module.exports = function (app) {

    // http://localhost:3000/eval/require/1?name=child_process
    // using req.param
    app.get("/eval/require/1", async (req, res) => {
        // ruleid: rules_lgpl_javascript_eval_rule-eval-require
        var cp = require(req.param("name"));
        cp.exec('ls', (error, stdout, stderr) => {
            console.log("exec output : \n", stdout)
        });
        res.send("Please check console logs.");
    });

    // using a seperate function
    const testFunc = (req, res) => {
        // ruleid: rules_lgpl_javascript_eval_rule-eval-require
        var cp = require(req.param("name"));
        cp.exec('ls', (error, stdout, stderr) => {
            console.log("exec output : \n", stdout)
        });    
    }
    // http://localhost:3000/eval/require/2?name=child_process
    app.get("/eval/require/2", async (req, res) => {
        testFunc(req, res);
        res.send("Please check console logs.");
    });

    // http://localhost:3000/eval/require/3?name=child_process
    // using req.query
    app.get("/eval/require/3", async (req, res) => {
        // ruleid: rules_lgpl_javascript_eval_rule-eval-require
        var cp = require(req.query.name);
        cp.exec('ls', (error, stdout, stderr) => {
            console.log("exec output : \n", stdout)
        });
        res.send("Please check console logs.");
    });

    // http://localhost:3000/eval/require/4?name=child_process
    // using a self-executing function
    app.get("/eval/require/4", async (req, res) => {
        (function (req, res) {
            // ruleid: rules_lgpl_javascript_eval_rule-eval-require
            var cp = require(req.query.name);
            cp.exec('ls', (error, stdout, stderr) => {
                console.log("exec output : \n", stdout)
            });
            res.send("Please check console logs.");
        })(req, res)
    });

    // http://localhost:3000/eval/require/5
    app.get("/eval/require/5", async (req, res) => {
        // ok: rules_lgpl_javascript_eval_rule-eval-require
        var cp = require('child_process');
        cp.exec('ls', (error, stdout, stderr) => {
            console.log("exec output : \n", stdout)
        });
        res.send("Please check console logs.");
    });

    // http://localhost:3000/eval/require/6?name=child_process
    // using a self-executing function
    app.get("/eval/require/6", async (req, res) => {
        (function (req, res) {
            var val = req.query.name;
            // ruleid: rules_lgpl_javascript_eval_rule-eval-require
            var cp = require(val);
            cp.exec('ls', (error, stdout, stderr) => {
                console.log("exec output : \n", stdout)
            });
            res.send("Please check console logs.");
        })(req, res)
    });

    // Safe - will not be exploited.
    const allowedPkg = [ 'child_process' ];

    // http://localhost:3000/eval/require/7?name=child_process
    // using allow list to validate the user input
    app.get("/eval/require/7", async (req, res) => {
        var isAllowed = allowedPkg.includes(req.query.name);  
        if (isAllowed) {
            // ok: rules_lgpl_javascript_eval_rule-eval-require
            var cp = require(req.query.name);
            cp.exec('ls', (error, stdout, stderr) => {
                console.log("exec output : \n", stdout)
            });        
        }
        res.send("Please check console logs.");
    });
}