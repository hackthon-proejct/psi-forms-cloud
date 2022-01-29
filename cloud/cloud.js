/* global Moralis */

const IS_TESTNET = false;

const EMAIL_APP_KEY = '*';
const EMAIL_APP_SECRET = '*';
const EMAIL_SMTP = '*';
const EMAIL_FROM = 'noreply@psiforms.com';

const logger = Moralis.Cloud.getLogger();

const Form = Moralis.Object.extend("Form");
const FormCreated = Moralis.Object.extend("FormCreated");
const PreReceipt = Moralis.Object.extend("PreReceipt");
const PostReceipt = Moralis.Object.extend("PostReceipt");
const Request = Moralis.Object.extend("Request");
const RequestCreated = Moralis.Object.extend("RequestCreated");
const CreatorProfile = Moralis.Object.extend("CreatorProfile");
const EmailLog = Moralis.Object.extend("EmailLog");

const RequestStatus = {
	pending: 1,
	approved: 2,
	rejected: 3,
	rolledBack: 4
};

// =====================================================================
// ================================ utils ==============================
// =====================================================================

function requireMaster(request) {
	if (!request.master) {
		throw new Error('Forbidden');
	}
}

function lockColumnsForChanging(request, columnNames) {
	for (let columnName of columnNames) {
		if (request.original) {
			if (request.original.get(columnName) !== request.object.get(columnName)) {
				throw new Error(`You cannot change column ${columnName}`);
			}
		} else if (request.object.get(columnName) !== null) {
			throw new Error(`Cannot set not null value for column ${columnName}`);
		}
	}
}

function dec2hex(str) {
	const pad = 32;
	const dec = str.split('');
	const sum = [];
	const hex = [];
	while (dec.length > 0) {
		let s = 1 * dec.shift();
		for (let i = 0; s || i < sum.length; i++) {
			s += (sum[i] || 0) * 10;
			sum[i] = s % 16;
			s = (s - sum[i]) / 16;
		}
	}
	while (sum.length > 0) {
		hex.push(sum.pop().toString(16));
	}
	if (hex.length < pad) {
		for (let j = hex.length; j < pad; j++) {
			hex.unshift('0');
		}
	}
	return '0x' + hex.join('');
}

function createUrl(path) {
	return IS_TESTNET
		? `https://testnet.psiforms.com${path}`
		: `https://psiforms.com${path}`;
}

// =====================================================================
// =============================== objects =============================
// =====================================================================

async function tryReadObject(newObject, columnName, value) {
	const obj = await(new Moralis.Query(newObject)
		.equalTo(columnName, value))
		.first({ useMasterKey: true });
	return obj ? obj : null;
}

async function readObject(newObject, columnName, value) {
	const obj = await tryReadObject(newObject, columnName, value);
	if (!obj) {
		throw new Error('Cannot find ' + columnName + ' = ' + value);
	}
	return obj;
}

function filterACLUserIds(obj, skipIds) {
	return Object.keys(obj.getACL().toJSON()).filter(u => !skipIds.includes(u));
}

// =====================================================================
// ================================ email ==============================
// =====================================================================

async function logEmail(email, subject, body) {
	const acl = new Moralis.ACL();
	acl.setPublicReadAccess(false);
	acl.setPublicWriteAccess(false);
	const log = new EmailLog();
	log.set('email', email);
	log.set('subject', subject);
	log.set('body', body);
	log.setACL(acl);
	await log.save({}, { useMasterKey: true });
}

async function sendEmailByAPI(email, subject, body) {
	try {
		const token = Buffer.from(EMAIL_APP_KEY + ':' + EMAIL_APP_SECRET).toString('base64');
		const params = {
			smtp_account: EMAIL_SMTP,
			subject,
			text: body,
			from: EMAIL_FROM
		};
		params[`to[${email}][reciver_name]`] = email;
		params[`to[${email}][message_id]`] = Date.now();

		await Moralis.Cloud.httpRequest({
			method: 'POST',
			url: 'https://api.emaillabs.net.pl/api/new_sendmail',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Authorization': `Basic ${token}`
			},
			body: new URLSearchParams(params).toString()
		});
	} catch (e) {
		logger.error(`Couldn't send e-mail to ${email}! ` + JSON.stringify(e));
	}
}

async function sendEmail(email, subject, body) {
	const prefix = IS_TESTNET
		? '[ΨForms:TestNet] '
		: '[ΨForms] ';
	subject = prefix + subject;
	body += '\n\nPowered by ' + createUrl('/');

	await logEmail(email, subject, body);
	await sendEmailByAPI(email, subject, body);
}

// =====================================================================
// ============================ before save ============================
// =====================================================================

Moralis.Cloud.beforeSave('Form', (request) => {
	if (!request.master) {
		lockColumnsForChanging(request, ['isEnabled', 'requireApproval']);
	}
});

async function syncForm(request, syncRequireApproval) {
	const formId = request.object.get('formId');

	const form = await readObject(Form, 'formId', formId);
	form.set('isEnabled', request.object.get('isEnabled'));
	if (syncRequireApproval) {
		form.set('requireApproval', request.object.get('requireApproval'));
	}
	await form.save({}, { useMasterKey: true });
}

Moralis.Cloud.beforeSave('FormCreated', async (request) => {
	requireMaster(request);
	await syncForm(request, true);
});

Moralis.Cloud.beforeSave('FormUpdated', async (request) => {
	requireMaster(request);
	await syncForm(request, false);
});

Moralis.Cloud.beforeSave('Request', (request) => {
	if (!request.master) {
		lockColumnsForChanging(request, ['creator', 'status', 'value']);
	}
});

Moralis.Cloud.beforeSave('RequestCreated', (request) => {
	requireMaster(request);
});

Moralis.Cloud.beforeSave('RequestRejected', (request) => {
	requireMaster(request);
});

Moralis.Cloud.beforeSave('RequestApproved', (request) => {
	requireMaster(request);
});

Moralis.Cloud.beforeSave('RequestRolledBack', (request) => {
	requireMaster(request);
});

// =====================================================================
// ============================= after save ============================
// =====================================================================

async function getFormRequestContext(request) {
	const confirmed = request.object.get('confirmed');
	const formRequestId = request.object.get('requestId');
	const formRequest = await readObject(Request, 'requestId', formRequestId);
	const formId = formRequest.get('formId');
	const form = await readObject(Form, 'formId', formId);
	return {
		confirmed,
		formRequestId,
		formRequest,
		formId,
		form
	};
}

async function addSenderAsReaderToReceipt(context, eventName) {
	const formCreated = await readObject(FormCreated, 'formId', context.formId);
	const formRequireApproval = formCreated.get('requireApproval');
	if (eventName === 'RequestCreated' && !formRequireApproval) {
		logger.info(`form ${context.formId} does not require approval, updating pre receipt skipped for request ${context.formRequestId}`);
		return;
	}

	const formCreatorUserId = filterACLUserIds(context.form, ['*'])[0];

	const reqSenderUserIds = filterACLUserIds(context.formRequest, ['*', formCreatorUserId]);
	const reqSenderUserId = (reqSenderUserIds.length > 0)
		? reqSenderUserIds[0]
		: null;
	if (!reqSenderUserId) {
		logger.info(`request ${context.formRequestId} has same sender as creator of form`);
		return;
	}

	const Receipt = (eventName === 'RequestCreated')
		? PreReceipt
		: PostReceipt;
	const receipt = await readObject(Receipt, 'formId', context.formId);
	const receiptACL = receipt.getACL();
	if (receiptACL.getReadAccess(reqSenderUserId)) {
		logger.info(`receipt for form ${context.formId} already contains access for sender of request ${context.formRequestId}`);
		return;
	}

	receiptACL.setReadAccess(reqSenderUserId, true);
	receiptACL.setWriteAccess(reqSenderUserId, false);
	receipt.setACL(receiptACL);

	await receipt.save({}, { useMasterKey: true });
	logger.info(`just updated ACL of receipt for request ${context.formRequestId}`);
}

async function syncRequest(context, status) {
	if (!context.formRequest.has('creator')) {
		context.formRequest.set('creator', context.form.get('creator'));
	}
	if (!context.formRequest.has('value')) {
		const requestCreated = await readObject(RequestCreated, 'requestId', context.formRequestId);
		context.formRequest.set('value', requestCreated.get('value'));
	}

	context.formRequest.set('status', status);
	await context.formRequest.save({}, { useMasterKey: true });
}

Moralis.Cloud.afterSave('RequestCreated', async (request) => {
	const context = await getFormRequestContext(request);

	if (!context.confirmed) {
		await addSenderAsReaderToReceipt(context, 'RequestCreated');
		await syncRequest(context, RequestStatus.pending);
	}
	if (context.confirmed) {
		const creator = context.form.get('creator');
		const creatorProfile = await tryReadObject(CreatorProfile, 'creator', creator);
		if (creatorProfile) {
			const creatorEmail = creatorProfile.get('email');
			if (creatorEmail) {
				const formRequestIdHex = dec2hex(context.formRequestId);
				const pendingRequestsUrl = createUrl('/pending-requests');

				await sendEmail(creatorEmail,
					`You have a new request (${formRequestIdHex})`,
					`You have a new request.\nRequest ID: ${formRequestIdHex}\n\n` +
					`Pending requests: ${pendingRequestsUrl}`);
			}
		}
	}
});

Moralis.Cloud.afterSave('RequestApproved', async (request) => {
	const context = await getFormRequestContext(request);

	if (!context.confirmed) {
		await addSenderAsReaderToReceipt(context, 'RequestApproved');
		await syncRequest(context, RequestStatus.approved);
	}
	if (context.confirmed) {
		const senderEmail = context.formRequest.get('email');
		const formRequestIdHex = dec2hex(context.formRequestId);
		const postReceiptUrl = createUrl(`/requests/${formRequestIdHex}/post-receipt`);

		await sendEmail(senderEmail,
			`Your request is approved (${formRequestIdHex})`,
			`Your request is approved!\nRequest ID: ${formRequestIdHex}\n\n` +
			`Please continue here: ${postReceiptUrl}`);
	}
});

Moralis.Cloud.afterSave('RequestRejected', async (request) => {
	const context = await getFormRequestContext(request);

	if (!context.confirmed) {
		await syncRequest(context, RequestStatus.rejected);
	}
	if (context.confirmed) {
		const senderEmail = context.formRequest.get('email');
		const formRequestIdHex = dec2hex(context.formRequestId);

		await sendEmail(senderEmail,
			`Your request is rejected (${formRequestIdHex})`,
			`The owner of the form has rejected your request. Your payment has been refunded.\nRequest ID: ${formRequestIdHex}`);
	}
});

Moralis.Cloud.afterSave('RequestRolledBack', async (request) => {
	const context = await getFormRequestContext(request);
	if (!context.confirmed) {
		await syncRequest(context, RequestStatus.rolledBack);
	}
});
