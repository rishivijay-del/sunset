// Simulates someone still writing Market_Zone__c during quarantine.
Account a = [SELECT Id FROM Account WHERE Market_Zone__c != null LIMIT 1];
a.Market_Zone__c = 'EMEA';
update a;
