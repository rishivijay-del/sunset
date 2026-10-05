import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import ZONE from '@salesforce/schema/Account.Market_Zone__c';
import NAME from '@salesforce/schema/Account.Name';

export default class ZoneBadge extends LightningElement {
    @api recordId;

    @wire(getRecord, { recordId: '$recordId', fields: [NAME, ZONE] })
    account;

    get label() {
        const zone = getFieldValue(this.account.data, ZONE);
        return zone ? `Zone: ${zone}` : 'No zone';
    }
}
