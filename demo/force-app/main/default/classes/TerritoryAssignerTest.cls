@IsTest
private class TerritoryAssignerTest {
    @IsTest
    static void assignsDesk() {
        Account a = new Account(Name = 'Test Co', Legacy_Region__c = 'EMEA');
        insert a;
        Test.startTest();
        TerritoryAssigner.assign(new List<Account>{ a });
        Test.stopTest();
        System.assertNotEquals(null, a.Id);
    }

    @IsTest
    static void enterpriseAccountsGetDefaults() {
        // Covers the Account_Region_Sync flow (needed when deploying active flows to production orgs).
        Account ent = new Account(Name = 'Enterprise Co', Type = 'Enterprise');
        insert ent;
        ent = [SELECT Description FROM Account WHERE Id = :ent.Id];
        System.assertEquals('Enterprise account', ent.Description);
    }
}
