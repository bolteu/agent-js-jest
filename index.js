/*
 *  Copyright 2020 EPAM Systems
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

const RPClient = require('@reportportal/client-javascript');
const glob = require('glob');
const sanitizeFilename = require('sanitize-filename');
const escapeGlob = require('glob-escape');
const fs = require('fs');
const {
    getClientInitObject, getSuiteStartObject,
    getStartLaunchObject, getTestStartObject, getStepStartObject,
    getAgentInfo, getCodeRef, getFullTestName, getFullStepName,
} = require('./utils/objectUtils');
const getOptions = require('./utils/getOptions');

const testItemStatuses = { PASSED: 'passed', FAILED: 'failed', SKIPPED: 'pending' };
const logLevels = {
    ERROR: 'error',
    TRACE: 'trace',
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
};

const promiseErrorHandler = (promise) => {
    promise.catch((err) => {
        console.log(err); // suppressed to not affect GitHub actions
        console.log('::set-output name=RP_ERROR::true');
    });
};

class JestReportPortal {
    constructor(globalConfig, options) {
        const agentInfo = getAgentInfo();
        this.reportOptions = getClientInitObject(getOptions.options(options));
        this.client = new RPClient(this.reportOptions, agentInfo);
        this.tempSuiteIds = new Map();
        this.tempTestIds = new Map();
        this.tempStepId = null;
        this.promises = [];
        this.disabled = this.reportOptions.disabled;
        this.disableUploadAttachments = this.reportOptions.disableUploadAttachments;
    }

    // eslint-disable-next-line no-unused-vars
    onRunStart() {
        if (this.disabled) return;

        const startLaunchObj = getStartLaunchObject(this.reportOptions);
        const { tempId, promise } = this.client.startLaunch(startLaunchObj);

        this.tempLaunchId = tempId;
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    // eslint-disable-next-line no-unused-vars
    onTestResult(test, testResult) {
        if (this.disabled) return;

        let suiteDuration = 0;
        let testDuration = 0;
        for (let result = 0; result < testResult.testResults.length; result++) {
            suiteDuration += testResult.testResults[result].duration;
            if (testResult.testResults[result].ancestorTitles.length !== 1) {
                testDuration += testResult.testResults[result].duration;
            }
        }

        testResult.testResults.forEach((t) => {
            if (t.ancestorTitles.length > 0) {
                this._startSuite(t.ancestorTitles[0], test.path, suiteDuration);
            }
            if (t.ancestorTitles.length > 1) {
                this._startTest(t, test.path, testDuration);
            }

            if (parseInt(process.env.DETOX_RERUN_INDEX, 10) > 0) {
                this._startStep(t, true, test.path);
                this._finishStep(t, true, parseInt(process.env.DETOX_RERUN_INDEX, 10));
                return;
            }

            if (!t.invocations) {
                this._startStep(t, false, test.path);
                this._finishStep(t, false);
                return;
            }

            for (let i = 0; i < t.invocations; i++) {
                const isRetried = t.invocations !== 1;
                this._startStep(t, isRetried, test.path);
                this._finishStep(t, isRetried, i);
            }
        });

        this.tempTestIds.forEach((tempTestId, key) => {
            this._finishTest(tempTestId, key);
        });
        this.tempSuiteIds.forEach((tempSuiteId, key) => {
            this._finishSuite(tempSuiteId, key);
        });
    }

    // eslint-disable-next-line no-unused-vars
    async onRunComplete() {
        if (this.disabled) return;

        await Promise.all(this.promises);
        if (this.reportOptions.launchId) return;
        const { promise } = this.client.finishLaunch(this.tempLaunchId);

        if (this.reportOptions.logLaunchLink === true) {
            promise.then((response) => {
                console.log(`\nReportPortal Launch Link: ${response.link}`);
                console.log(`::set-output name=RP_LINK::${response.link}`);
            });
        }

        promiseErrorHandler(promise);
        await promise;
    }

    _startSuite(suiteName, path, suiteDuration) {
        if (this.tempSuiteIds.get(suiteName)) {
            return;
        }
        const codeRef = getCodeRef(path, suiteName);
        const { tempId, promise } = this.client.startTestItem(getSuiteStartObject(suiteName, codeRef, suiteDuration),
            this.tempLaunchId);

        this.tempSuiteIds.set(suiteName, tempId);
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _startTest(test, testPath, testDuration) {
        if (this.tempTestIds.get(test.ancestorTitles.join('/'))) {
            return;
        }

        const tempSuiteId = this.tempSuiteIds.get(test.ancestorTitles[0]);
        const fullTestName = getFullTestName(test);
        const codeRef = getCodeRef(testPath, fullTestName);
        const testStartObj = getTestStartObject(
            test.ancestorTitles[test.ancestorTitles.length - 1], codeRef, testDuration,
        );
        const parentId = this.tempTestIds.get(test.ancestorTitles.slice(0, -1).join('/')) || tempSuiteId;
        const { tempId, promise } = this.client.startTestItem(testStartObj, this.tempLaunchId, parentId);

        this.tempTestIds.set(fullTestName, tempId);
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _startStep(test, isRetried, testPath) {
        const tempSuiteId = this.tempSuiteIds.get(test.ancestorTitles[0]);
        const fullStepName = getFullStepName(test);
        const codeRef = getCodeRef(testPath, fullStepName);
        const stepDuration = test.duration;
        const stepStartObj = getStepStartObject(test.title, isRetried, codeRef, stepDuration);
        const parentId = this.tempTestIds.get(test.ancestorTitles.join('/')) || tempSuiteId;
        const { tempId, promise } = this.client.startTestItem(stepStartObj, this.tempLaunchId, parentId);

        this.tempStepId = tempId;
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _finishStep(test, isRetried, invocation) {
        const errorMsg = test.failureMessages[0];

        switch (test.status) {
        case testItemStatuses.PASSED:
            this._finishPassedStep(isRetried);
            break;
        case testItemStatuses.FAILED:
            this._finishFailedStep(errorMsg, isRetried, test, invocation);
            break;
        default:
            this._finishSkippedStep(isRetried);
        }
    }

    _finishPassedStep(isRetried) {
        const status = testItemStatuses.PASSED;
        const finishTestObj = { status, retry: isRetried };
        const { promise } = this.client.finishTestItem(this.tempStepId, finishTestObj);

        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _finishFailedStep(failureMessage, isRetried, test, invocation) {
        const status = testItemStatuses.FAILED;
        const finishTestObj = { status, retry: isRetried };

        this._sendLog(failureMessage, test, invocation);

        const { promise } = this.client.finishTestItem(this.tempStepId, finishTestObj);

        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _sendLog(message, test, invocation) {
        const logObject = {
            message,
            level: logLevels.ERROR,
        };

        const { promise } = this.client.sendLog(this.tempStepId, logObject);

        promiseErrorHandler(promise);
        this.promises.push(promise);

        if (this.disableUploadAttachments) return;

        const attachments = this._getAttachments(test, invocation);
        if (attachments.length > 0) {
            // add attachments to test log
            attachments.forEach((attachment) => {
                const logObject = {
                    message: `Attachment: ${attachment.name}`,
                    level: logLevels.DEBUG,
                };
                const { promise } = this.client.sendLog(this.tempStepId, logObject, attachment);
                promiseErrorHandler(promise);
                this.promises.push(promise);
            });
        }
    }

    _getAttachments(test, invocation) {
        if (!test) {
            return [];
        }
        const attachments = [];
        let testName = test.fullName;
        let filenamePrefix = '';
        if (invocation > 0) {
            testName = `${testName} (${invocation + 1})`;
            filenamePrefix = `Retry ${invocation + 1} - `;
        }
        // eslint-disable-next-line max-len
        const files = glob.sync(`${this.reportOptions.artifactsPath}/*/*+(${this._convertTestNameToDirectory(testName)})/*.?(png|log|mp4)`);

        files.forEach((path) => {
            const filename = filenamePrefix + path.replace(/^.*[\\\/]/, '');
            const extension = filename.split('.').pop();

            let mimetype;
            switch (extension) {
            case 'mp4':
                mimetype = 'video/mp4';
                break;
            case 'png':
                mimetype = 'image/png';
                break;
            default:
                mimetype = 'text/plain';
            }

            attachments.push({
                name: filename,
                type: mimetype,
                content: fs.readFileSync(path),
            });
        });

        return attachments;
    }

    _convertTestNameToDirectory(testName) {
        const SANITIZE_OPTIONS = { replacement: '_' };
        return escapeGlob(sanitizeFilename(testName, SANITIZE_OPTIONS));
    }

    _finishSkippedStep(isRetried) {
        const status = 'skipped';
        const issue = this.reportOptions.skippedIssue === false ? { issueType: 'NOT_ISSUE' } : null;
        const finishTestObj = {
            status,
            retry: isRetried,
            ...(issue && { issue }),
        };
        const { promise } = this.client.finishTestItem(this.tempStepId, finishTestObj);

        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _finishTest(tempTestId, key) {
        if (!tempTestId) return;

        const { promise } = this.client.finishTestItem(tempTestId, {});

        this.tempTestIds.delete(key);
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }

    _finishSuite(tempSuiteId, key) {
        if (!tempSuiteId) return;

        const { promise } = this.client.finishTestItem(tempSuiteId, {});

        this.tempSuiteIds.delete(key);
        promiseErrorHandler(promise);
        this.promises.push(promise);
    }
}

module.exports = JestReportPortal;
