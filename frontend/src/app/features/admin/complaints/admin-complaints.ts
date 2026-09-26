import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageModule } from 'primeng/message';

import {
  AdminComplaintsService,
  BatchItemOption,
  ComplaintRow,
  HandedOverItemOption,
} from '../../../core/services/admin-complaints.service';
import { ComplaintDecision } from '../../../core/models/db-types';

@Component({
  selector: 'app-admin-complaints',
  standalone: true,
  imports: [DatePipe, FormsModule, TableModule, TagModule, ButtonModule, DialogModule, SelectModule, InputNumberModule, TextareaModule, SkeletonModule, MessageModule],
  templateUrl: './admin-complaints.html',
  styleUrl: './admin-complaints.scss',
})
export class AdminComplaints implements OnInit {
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly complaints = signal<ComplaintRow[]>([]);

  readonly actionRunning = signal(false);
  readonly actionError = signal<string | null>(null);

  readonly reportDialogVisible = signal(false);
  readonly handedOverItems = signal<HandedOverItemOption[]>([]);
  readonly selectedOrderItemId = signal<string | null>(null);
  readonly reportReason = signal('');

  readonly resolveDialogVisible = signal(false);
  readonly resolveTarget = signal<ComplaintRow | null>(null);
  readonly resolveDecision = signal<ComplaintDecision>('sonstige');
  readonly resolveNote = signal('');
  readonly resolveCost = signal<number | null>(null);
  readonly batchItems = signal<BatchItemOption[]>([]);
  readonly resolveReplacementBatchItemId = signal<string | null>(null);

  readonly decisionOptions: { label: string; value: ComplaintDecision }[] = [
    { label: 'Ersatzproduktion', value: 'ersatzproduktion' },
    { label: 'Rückerstattung', value: 'rueckerstattung' },
    { label: 'Sonstige', value: 'sonstige' },
  ];

  constructor(private readonly complaintsService: AdminComplaintsService) {}

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.complaints.set(await this.complaintsService.listComplaints());
    } catch {
      this.error.set('Reklamationen konnten nicht geladen werden.');
    } finally {
      this.loading.set(false);
    }
  }

  async openReportDialog(): Promise<void> {
    this.selectedOrderItemId.set(null);
    this.reportReason.set('');
    this.actionError.set(null);
    this.reportDialogVisible.set(true);
    try {
      this.handedOverItems.set(await this.complaintsService.getHandedOverItems());
    } catch {
      this.handedOverItems.set([]);
    }
  }

  async confirmReport(): Promise<void> {
    const orderItemId = this.selectedOrderItemId();
    const reason = this.reportReason().trim();
    if (!orderItemId || !reason) return;
    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.complaintsService.reportComplaint(orderItemId, reason);
      this.reportDialogVisible.set(false);
      await this.load();
    } catch {
      this.actionError.set('Reklamation konnte nicht angelegt werden.');
    } finally {
      this.actionRunning.set(false);
    }
  }

  async openResolveDialog(complaint: ComplaintRow): Promise<void> {
    this.resolveTarget.set(complaint);
    this.resolveDecision.set('sonstige');
    this.resolveNote.set('');
    this.resolveCost.set(null);
    this.resolveReplacementBatchItemId.set(null);
    this.actionError.set(null);
    this.resolveDialogVisible.set(true);
    try {
      this.batchItems.set(await this.complaintsService.getRecentBatchItems());
    } catch {
      this.batchItems.set([]);
    }
  }

  async confirmResolve(): Promise<void> {
    const complaint = this.resolveTarget();
    const note = this.resolveNote().trim();
    if (!complaint || !note) return;
    if (this.resolveDecision() === 'ersatzproduktion' && !this.resolveReplacementBatchItemId()) return;

    this.actionRunning.set(true);
    this.actionError.set(null);
    try {
      await this.complaintsService.resolveComplaint(
        complaint.id,
        this.resolveDecision(),
        note,
        this.resolveCost(),
        this.resolveDecision() === 'ersatzproduktion' ? this.resolveReplacementBatchItemId() : null,
      );
      this.resolveDialogVisible.set(false);
      await this.load();
    } catch {
      this.actionError.set('Reklamation konnte nicht gelöst werden.');
    } finally {
      this.actionRunning.set(false);
    }
  }
}
