// Simulates a user still writing Legacy_Region__c during quarantine (to demo a quarantine signal).
Account a = [SELECT Id FROM Account WHERE Legacy_Region__c != null LIMIT 1];
a.Legacy_Region__c = 'EMEA';
update a;
