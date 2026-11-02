import salesforce from 'eslint-config-salesforce-typescript';

export default [
  ...salesforce,
  {
    // The shared config expects Salesforce's own Apache license header; this repo is MIT with no file headers.
    rules: { 'header/header': 'off' },
  },
];
