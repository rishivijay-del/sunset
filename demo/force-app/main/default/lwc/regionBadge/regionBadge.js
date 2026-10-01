import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import REGION from '@salesforce/schema/Account.Legacy_Region__c';
import NAME from '@salesforce/schema/Account.Name';

export default class RegionBadge extends LightningElement {
    @api recordId;

    @wire(getRecord, { recordId: '$recordId', fields: [NAME, REGION] })
    account;

    get label() {
        const region = getFieldValue(this.account.data, REGION);
        return region ? `Region: ${region}` : 'No region';
    }
}
