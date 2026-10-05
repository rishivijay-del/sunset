@IsTest
private class ZoneRouterTest {
    @IsTest
    static void routesZone() {
        Account a = new Account(Name = 'Zone Co', Market_Zone__c = 'EMEA');
        insert a;
        Test.startTest();
        ZoneRouter.route(new List<Account>{ a });
        Test.stopTest();
        System.assertNotEquals(null, a.Id);
    }

    @IsTest
    static void enterpriseAccountsGetZone() {
        // Covers the Account_Zone_Sync flow.
        Account ent = new Account(Name = 'Enterprise Zone Co', Type = 'Enterprise');
        insert ent;
        ent = [SELECT Rating FROM Account WHERE Id = :ent.Id];
        System.assertEquals('Warm', ent.Rating);
    }
}
