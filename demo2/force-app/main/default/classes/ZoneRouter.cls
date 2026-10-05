public with sharing class ZoneRouter {
    public static void route(List<Account> accounts) {
        for (Account a : [SELECT Id, Description, Market_Zone__c FROM Account WHERE Id IN :accounts]) {
            if (a.Market_Zone__c == 'EMEA') {
                a.Description = 'Routed to EMEA zone desk';
            } else {
                a.Description = 'Routed to global zone desk';
            }
        }
    }
}
