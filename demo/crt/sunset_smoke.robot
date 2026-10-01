*** Settings ***
Documentation     Sunset smoke test: the Account list and a record page still open after each phase.
...               Starting point only. Adjust to your org, or ask the Copado Test agent to generate one.
Library           QForce
Suite Setup       Open Browser    about:blank    chrome
Suite Teardown    Close All Browsers

*** Variables ***
${login_url}      https://login.salesforce.com
${username}       %{SF_USERNAME}
${password}       %{SF_PASSWORD}

*** Test Cases ***
Accounts load
    GoTo              ${login_url}
    TypeText          Username    ${username}
    TypeSecret        Password    ${password}
    ClickText         Log In
    VerifyText        Home        timeout=60
    GoTo              ${login_url}/lightning/o/Account/list
    VerifyText        Accounts    timeout=60
