const fs = require('fs');

const dotEnv = fs.readFileSync('.env').toString();

const maskedDotEnv = dotEnv.replace(/\b([A-Z_]+)=(.+)/g, (_fullMatch, envName, envVal) => {
    let value;
    if (envName.includes('HOST')) {
        value = envVal;
    } else {
        value = envVal.replace(/\W/g, '_').replace(/[0-9]/g, 9).replace(/[a-zA-Z]/g, 'x');
    }
    return `${envName}=${value}`;
});

fs.writeFileSync('.env.example', maskedDotEnv);

console.log('Example updated:\n', maskedDotEnv);
