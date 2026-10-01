import { LightningElement, api, wire } from 'lwc';
import REGION from '@salesforce/schema/Account.Legacy_Region__c';
export default class RegionBadge extends LightningElement {
    @api recordId;
    fields = [REGION];
}
