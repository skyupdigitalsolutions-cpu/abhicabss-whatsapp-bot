const { getPrisma } = require('../config/db');

/** Same purpose as sessionRecord.js, for the customers table. */
class CustomerRecord {
  constructor(row) {
    this.id = row.id;
    this.whatsappNumber = row.whatsappNumber;
    this.name = row.name;
    this.email = row.email;
    this.preferredLanguage = row.preferredLanguage;
    this.customerType = row.customerType;
    this.companyName = row.companyName;
    this.gstNumber = row.gstNumber;
    this.lastInteractionAt = row.lastInteractionAt;
  }

  get _id() {
    return this.id;
  }

  async save() {
    const prisma = getPrisma();
    await prisma.customer.update({
      where: { id: this.id },
      data: {
        name: this.name,
        email: this.email,
        preferredLanguage: this.preferredLanguage,
        customerType: this.customerType,
        companyName: this.companyName,
        gstNumber: this.gstNumber,
        lastInteractionAt: this.lastInteractionAt,
      },
    });
    return this;
  }
}

function wrapCustomer(row) {
  return row ? new CustomerRecord(row) : null;
}

module.exports = { CustomerRecord, wrapCustomer };
