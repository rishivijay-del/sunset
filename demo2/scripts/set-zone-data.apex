// Gives 3 accounts a Market Zone (0.3% of 1,000), avoiding the trap and old-demo records.
List<Account> accts = [SELECT Id FROM Account WHERE Sync_Status__c = null AND Market_Zone__c = null AND Type = null ORDER BY Name LIMIT 3];
List<String> zones = new List<String>{ 'EMEA', 'APAC', 'LATAM' };
for (Integer i = 0; i < accts.size(); i++) {
    accts[i].Market_Zone__c = zones[i];
}
update accts;
System.debug('Zoned ' + accts.size() + ' accounts');
