// Simulates the ERP integration writing Sync_Status__c right now.
// Run AFTER you set usage.ignoreWritesBefore, so Sunset sees these as live usage.
List<Account> accts = [SELECT Id FROM Account WHERE Sync_Status__c != null LIMIT 50];
for (Account a : accts) {
    a.Sync_Status__c = 'Synced ' + String.valueOf(System.now());
}
update accts;
System.debug('Updated ' + accts.size() + ' accounts');
