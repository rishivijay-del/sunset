public with sharing class TerritoryAssigner {
    public static void assign(List<Account> accounts) {
        for (Account a : [SELECT Id, Legacy_Region__c FROM Account WHERE Id IN :accounts]) {
            if (a.Legacy_Region__c == 'EMEA') {
                a.Description = 'Routed to EMEA desk';
            }
        }
    }
}
